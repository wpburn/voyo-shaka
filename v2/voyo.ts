#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-run
// Voyo Live — single-file Deno 2 server.
// Routes:  GET /  • GET /api/channels  • POST /api/login
//          • GET /live/:id.m3u8           — non-DRM, HLS pass-through
//          • GET /live.m3u8               — combined VLC playlist (?mode=all includes DRM)
//          • GET /vlc/:id/index.m3u8      — server-decrypted DRM live (needs cdm.py sidecar)
//          • GET /api/keys/:id            — debug: hex content keys from sidecar
//          • GET /play/:id, /mosaic       — in-browser Shaka players (Chrome Widevine)
//          • GET /proxy?url=              — generic CORS/header passthrough used by /live

import { crypto as stdCrypto } from "jsr:@std/crypto/crypto";

// === Types ===
type Channel = { id: string; name: string; img: string; slug: string };
type StreamInfo = { url: string; isDrm: boolean; drm?: { url: string; headers: Record<string, string> } };
type Creds = { username: string; password: string };
type Session = { token: string | null; uuid: string | null; issuedAt: string | null };
type Config = {
  credentials: Creds;
  session: Session;
  channels: Channel[];
  channelsUpdatedAt: string | null;
};

// === Constants ===
const PORT = Number(Deno.env.get("VOYO_PORT") ?? 8090);

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

// === Stream info cache (signed URLs expire; ~30 min is safe) ===
const STREAM_TTL_MS = 30 * 60 * 1000;
const streamCache = new Map<string, { info: StreamInfo; expiresAt: number }>();

async function getStreamInfo(channelId: string, force = false): Promise<StreamInfo> {
  if (!force) {
    const hit = streamCache.get(channelId);
    if (hit && hit.expiresAt > Date.now()) return hit.info;
  }
  const info = await withAuth((t, u) => resolveStream(channelId, t, u));
  streamCache.set(channelId, { info, expiresAt: Date.now() + STREAM_TTL_MS });
  return info;
}

// === Widevine: PSSH extraction + CDM sidecar client + key cache ===
const CDM_URL = Deno.env.get("VOYO_CDM_URL") ?? "http://127.0.0.1:8091";
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

async function getKeys(channelId: string, force = false): Promise<ContentKey[]> {
  if (!force) {
    const hit = keyCache.get(channelId);
    if (hit && hit.expiresAt > Date.now()) return hit.keys;
  }
  const info = await getStreamInfo(channelId, force);
  if (!info.drm) throw new Error(`channel ${channelId} is not DRM`);
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
  keyCache.set(channelId, { keys, expiresAt: Date.now() + KEY_TTL_MS });
  return keys;
}

// === VLC DRM pipeline: fetch MPD → download fragments → decrypt with mp4decrypt → remux to HLS ===
const MP4DECRYPT = Deno.env.get("VOYO_MP4DECRYPT") ?? "mp4decrypt";
const LIVE_DIR = `${CONFIG_DIR}/live`;
const PIPE_IDLE_MS = 60 * 1000;
const PIPE_SYNC_FALLBACK_MS = 3_000;
const PIPE_SEGMENT_WINDOW = 8;
const PIPE_SEGMENT_RETENTION = 18;
const LOCAL_DASH_NAME = "stream.mpd";

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
  encryptedFile: string;
  decryptedFile: string;
  downloadedAt: number;
};
type LocalTrackState = {
  source: ParsedRepresentation;
  initFile: string;
  initReady: boolean;
  segments: LocalSegment[];
};
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};
type Pipe = {
  channelId: string;
  dir: string;
  ready: Promise<string>;
  readyResolve: Deferred<string>["resolve"];
  readyReject: Deferred<string>["reject"];
  lastAccess: number;
  stopRequested: boolean;
  keys: ContentKey[];
  syncIntervalMs: number;
  loop: Promise<void> | null;
  audio: LocalTrackState | null;
  video: LocalTrackState | null;
};
const pipes = new Map<string, Pipe>();
let mp4decryptChecked = false;

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function decodeXmlText(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
): { timescale: number; initUrl: string; segments: ParsedSegment[] } | null {
  const initialization = templateAttrs.initialization;
  const media = templateAttrs.media;
  if (!initialization || !media) return null;
  const timescale = Number(templateAttrs.timescale ?? "1") || 1;
  const startNumber = Number(templateAttrs.startNumber ?? "1") || 1;
  const initUrl = new URL(fillTemplate(initialization, representationId, bandwidth, startNumber, null), baseUrl).toString();
  const timeline = parseSegmentTimeline(templateInner);
  if (timeline.length === 0) return null;
  const segments: ParsedSegment[] = [];
  let segmentNumber = startNumber;
  let currentTime = timeline[0]?.time ?? 0;
  for (const entry of timeline) {
    if (entry.time != null) currentTime = entry.time;
    const repeat = entry.repeat < 0 ? 0 : entry.repeat;
    for (let i = 0; i <= repeat; i++) {
      const id = `n-${segmentNumber}`;
      segments.push({
        id,
        url: new URL(fillTemplate(media, representationId, bandwidth, segmentNumber, currentTime), baseUrl).toString(),
        number: segmentNumber,
        time: currentTime,
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
    ? buildSegmentsFromTemplate(mergedTemplateAttrs, templateInner, representationId, bandwidth, resolvedBase)
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

async function parseMpd(mpdUrl: string): Promise<ParsedMpd> {
  const res = await fetch(mpdUrl, { headers: proxyFetchHeaders() });
  if (!res.ok) throw new HttpError(res.status, `MPD fetch: ${res.status}`);
  const xml = await res.text();
  const mpdOpen = /<MPD\b([^>]*)>/i.exec(xml);
  const mpdAttrs = mpdOpen ? parseXmlAttributes(mpdOpen[1]) : {};
  const mpdBase = findXmlText(xml, "BaseURL");
  const baseUrl = mpdBase ? new URL(mpdBase, mpdUrl).toString() : mpdUrl;
  const periods = findXmlBlocks(xml, "Period");
  const period = periods[0];
  if (!period) throw new Error("MPD has no Period");
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
    const representations = findXmlBlocks(adaptation.inner, "Representation");
    if (representations.length === 0) {
      console.log(`[mpd] ${kind} adaptation without representations: ${JSON.stringify(adaptation.attrs)}`);
    }
    for (const representation of representations) {
      const parsed = resolveRepresentation(kind, representation, adaptation, resolvedAdaptationBase);
      if (!parsed || parsed.segments.length === 0) continue;
      (kind === "audio" ? audio : video).push(parsed);
    }
  }

  if (audio.length === 0 || video.length === 0) {
    console.log(`[mpd] parse result audio=${audio.length} video=${video.length} url=${mpdUrl}`);
  }

  return {
    minimumUpdatePeriodMs: parseIsoDurationMs(mpdAttrs.minimumUpdatePeriod) ?? PIPE_SYNC_FALLBACK_MS,
    audio,
    video,
  };
}

function chooseRepresentation(list: ParsedRepresentation[], preferredId?: string): ParsedRepresentation | null {
  if (preferredId) {
    const keep = list.find((item) => item.representationId === preferredId);
    if (keep) return keep;
  }
  return [...list].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
}

function mergeTrackState(kind: TrackKind, current: LocalTrackState | null, next: ParsedRepresentation): LocalTrackState {
  if (current && current.source.representationId === next.representationId && current.source.initUrl === next.initUrl) {
    current.source = next;
    return current;
  }
  return {
    source: next,
    initFile: `${kind}-init.mp4`,
    initReady: false,
    segments: [],
  };
}

function segmentFileStem(kind: TrackKind, segment: ParsedSegment): string {
  if (segment.number != null) return `${kind}-n${String(segment.number).padStart(8, "0")}`;
  return `${kind}-t${String(segment.time ?? 0).padStart(12, "0")}`;
}

async function downloadToFile(url: string, path: string): Promise<void> {
  const res = await fetch(url, { headers: proxyFetchHeaders() });
  if (!res.ok) throw new HttpError(res.status, `download ${res.status}: ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tmp = `${path}.tmp`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, path);
}

async function ensureMp4decrypt(): Promise<void> {
  if (mp4decryptChecked) return;
  try {
    await new Deno.Command(MP4DECRYPT, {
      args: ["--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`mp4decrypt not found: set VOYO_MP4DECRYPT or install Bento4 so "${MP4DECRYPT}" is on PATH`);
    }
    throw e;
  }
  mp4decryptChecked = true;
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

async function ensureTrackInit(track: LocalTrackState, dir: string, keys: ContentKey[]): Promise<void> {
  if (track.initReady) return;
  const encrypted = `${dir}/${track.initFile}.enc`;
  const decrypted = `${dir}/${track.initFile}`;
  await downloadToFile(track.source.initUrl, encrypted);
  await decryptFile(encrypted, decrypted, keys);
  track.initReady = true;
}

async function syncTrackSegments(track: LocalTrackState, dir: string, keys: ContentKey[]): Promise<void> {
  await ensureTrackInit(track, dir, keys);
  const window = track.source.segments.slice(-PIPE_SEGMENT_WINDOW);
  const keepIds = new Set(track.source.segments.slice(-PIPE_SEGMENT_RETENTION).map((segment) => segment.id));
  const known = new Set(track.segments.map((segment) => segment.id));

  for (const segment of window) {
    if (known.has(segment.id)) continue;
    const stem = segmentFileStem(track.source.kind, segment);
    const encryptedFile = `${stem}.m4s.enc`;
    const decryptedFile = `${stem}.m4s`;
    await downloadToFile(segment.url, `${dir}/${encryptedFile}`);
    await decryptFile(`${dir}/${encryptedFile}`, `${dir}/${decryptedFile}`, keys, `${dir}/${track.initFile}.enc`);
    track.segments.push({ ...segment, encryptedFile, decryptedFile, downloadedAt: Date.now() });
    known.add(segment.id);
  }

  const order = new Map(track.source.segments.map((segment, index) => [segment.id, index]));
  const survivors: LocalSegment[] = [];
  for (const segment of track.segments) {
    if (keepIds.has(segment.id)) {
      survivors.push(segment);
      continue;
    }
    await Deno.remove(`${dir}/${segment.encryptedFile}`).catch(() => {});
    await Deno.remove(`${dir}/${segment.decryptedFile}`).catch(() => {});
  }
  survivors.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  track.segments = survivors;
}

function isExpiredStreamError(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

async function refreshPipeState(pipe: Pipe, force = false): Promise<void> {
  const info = await getStreamInfo(pipe.channelId, force);
  if (!info.drm) throw new Error("channel is not DRM — use /live/<id>.m3u8");
  const mpd = await parseMpd(info.url);
  const video = chooseRepresentation(mpd.video, pipe.video?.source.representationId);
  const audio = chooseRepresentation(mpd.audio, pipe.audio?.source.representationId);
  if (!video || !audio) throw new Error("MPD did not expose both audio and video representations");
  pipe.video = mergeTrackState("video", pipe.video, video);
  pipe.audio = mergeTrackState("audio", pipe.audio, audio);
  pipe.syncIntervalMs = Math.max(1_000, mpd.minimumUpdatePeriodMs);
}

async function syncPipeOnce(pipe: Pipe): Promise<void> {
  try {
    await refreshPipeState(pipe);
    if (!pipe.video || !pipe.audio) throw new Error("pipe not initialized");
    await syncTrackSegments(pipe.video, pipe.dir, pipe.keys);
    await syncTrackSegments(pipe.audio, pipe.dir, pipe.keys);
  } catch (error) {
    if (!isExpiredStreamError(error)) throw error;
    console.log(`[pipe ${pipe.channelId}] stream URL expired — refreshing signed manifest`);
    await refreshPipeState(pipe, true);
    if (!pipe.video || !pipe.audio) throw new Error("pipe not initialized after refresh");
    await syncTrackSegments(pipe.video, pipe.dir, pipe.keys);
    await syncTrackSegments(pipe.audio, pipe.dir, pipe.keys);
  }
}

function pipeHasPlayableDash(pipe: Pipe): boolean {
  return !!(
    pipe.audio?.initReady &&
    pipe.video?.initReady &&
    (pipe.audio.segments.length ?? 0) > 1 &&
    (pipe.video.segments.length ?? 0) > 1
  );
}

function renderTrackManifest(track: LocalTrackState, adaptationId: string): string {
  const lang = track.source.language ? ` lang="${escapeXml(track.source.language)}"` : "";
  const timeline = track.segments.map((segment) => {
    const t = segment.time != null ? ` t="${segment.time}"` : "";
    return `            <S${t} d="${segment.duration}" />`;
  }).join("\n");
  const segmentUrls = track.segments.map((segment) => `          <SegmentURL media="${escapeXml(segment.decryptedFile)}" />`).join("\n");
  return [
    `    <AdaptationSet id="${adaptationId}" contentType="${track.source.kind}" mimeType="${escapeXml(track.source.mimeType)}"${lang} segmentAlignment="true">`,
    `      <Representation id="${escapeXml(track.source.representationId)}" bandwidth="${track.source.bandwidth}" codecs="${escapeXml(track.source.codecs)}">`,
    `        <SegmentList timescale="${track.source.timescale}">`,
    `          <Initialization sourceURL="${escapeXml(track.initFile)}" />`,
    `          <SegmentTimeline>`,
    timeline,
    `          </SegmentTimeline>`,
    segmentUrls,
    `        </SegmentList>`,
    `      </Representation>`,
    `    </AdaptationSet>`,
  ].join("\n");
}

function buildLocalDashManifest(pipe: Pipe): string {
  if (!pipe.audio || !pipe.video || !pipeHasPlayableDash(pipe)) {
    throw new Error("local DASH manifest is not ready yet");
  }
  const minUpdate = Math.max(1, Math.round(pipe.syncIntervalMs / 1000));
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT${minUpdate}S" profiles="urn:mpeg:dash:profile:isoff-live:2011">`,
    `  <Period id="p0" start="PT0S">`,
    renderTrackManifest(pipe.video, "video"),
    renderTrackManifest(pipe.audio, "audio"),
    `  </Period>`,
    `</MPD>`,
  ].join("\n");
}

async function writeLocalDashManifest(pipe: Pipe): Promise<void> {
  const manifest = buildLocalDashManifest(pipe);
  const path = `${pipe.dir}/${LOCAL_DASH_NAME}`;
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, manifest);
  await Deno.rename(tmp, path);
}

function playlistPath(dir: string, name: string): string {
  return `${dir}/${name}`;
}

function segmentDurationSeconds(track: LocalTrackState, segment: LocalSegment): number {
  return segment.duration / track.source.timescale;
}

function buildTrackPlaylist(track: LocalTrackState): string {
  const targetDuration = Math.max(
    1,
    Math.ceil(Math.max(...track.segments.map((segment) => segmentDurationSeconds(track, segment)))),
  );
  const mediaSequence = track.segments[0]?.number ?? 0;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    `#EXT-X-MAP:URI="${track.initFile}"`,
  ];
  for (const segment of track.segments) {
    lines.push(`#EXTINF:${segmentDurationSeconds(track, segment).toFixed(3)},`);
    lines.push(segment.decryptedFile);
  }
  return lines.join("\n") + "\n";
}

function buildMasterPlaylist(pipe: Pipe): string {
  if (!pipe.audio || !pipe.video) throw new Error("pipe not initialized");
  const audioLang = pipe.audio.source.language ?? "und";
  const combinedBandwidth = pipe.audio.source.bandwidth + pipe.video.source.bandwidth;
  const codecs = [pipe.video.source.codecs, pipe.audio.source.codecs].filter(Boolean).join(",");
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${audioLang}",LANGUAGE="${audioLang}",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${combinedBandwidth},CODECS="${codecs}",AUDIO="audio"`,
    "video.m3u8",
  ].join("\n") + "\n";
}

async function writeTextFileAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, body);
  await Deno.rename(tmp, path);
}

async function writeLocalHlsPlaylists(pipe: Pipe): Promise<void> {
  if (!pipe.audio || !pipe.video || !pipeHasPlayableDash(pipe)) {
    throw new Error("local HLS playlists are not ready yet");
  }
  await writeTextFileAtomic(playlistPath(pipe.dir, "audio.m3u8"), buildTrackPlaylist(pipe.audio));
  await writeTextFileAtomic(playlistPath(pipe.dir, "video.m3u8"), buildTrackPlaylist(pipe.video));
  await writeTextFileAtomic(playlistPath(pipe.dir, "index.m3u8"), buildMasterPlaylist(pipe));
}

async function runPipeLoop(pipe: Pipe): Promise<void> {
  while (!pipe.stopRequested) {
    try {
      await syncPipeOnce(pipe);
      if (pipeHasPlayableDash(pipe)) {
        await writeLocalDashManifest(pipe);
        await writeLocalHlsPlaylists(pipe);
      }
    } catch (e) {
      console.error(`[pipe ${pipe.channelId}] sync failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, pipe.syncIntervalMs));
  }
}

async function stopPipe(channelId: string, reason: string): Promise<void> {
  const pipe = pipes.get(channelId);
  if (!pipe) return;
  console.log(`[pipe ${channelId}] ${reason}`);
  pipe.stopRequested = true;
  pipes.delete(channelId);
  pipe.readyReject(new Error(reason));
}

async function startPipe(channelId: string): Promise<Pipe> {
  await ensureMp4decrypt();
  const dir = `${LIVE_DIR}/${channelId}`;
  await Deno.mkdir(dir, { recursive: true });
  await clearDir(dir);

  const ready = deferred<string>();
  const pipe: Pipe = {
    channelId,
    dir,
    ready: ready.promise,
    readyResolve: ready.resolve,
    readyReject: ready.reject,
    lastAccess: Date.now(),
    stopRequested: false,
    keys: await getKeys(channelId),
    syncIntervalMs: PIPE_SYNC_FALLBACK_MS,
    loop: null,
    audio: null,
    video: null,
  };
  pipes.set(channelId, pipe);

  try {
    await syncPipeOnce(pipe);
    if (!pipeHasPlayableDash(pipe)) throw new Error("not enough decrypted fragments to start remuxing");
    await writeLocalDashManifest(pipe);
    await writeLocalHlsPlaylists(pipe);
    pipe.loop = runPipeLoop(pipe);
    pipe.readyResolve(`${dir}/index.m3u8`);
    return pipe;
  } catch (e) {
    pipes.delete(channelId);
    await clearDir(dir).catch(() => {});
    pipe.readyReject(e);
    throw e;
  }
}

async function ensurePipe(channelId: string): Promise<string> {
  const existing = pipes.get(channelId);
  if (existing) {
    existing.lastAccess = Date.now();
    await existing.ready;
    return existing.dir;
  }
  const pipe = await startPipe(channelId);
  await pipe.ready;
  pipe.lastAccess = Date.now();
  return pipe.dir;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, pipe] of pipes) {
    if (now - pipe.lastAccess > PIPE_IDLE_MS) {
      void stopPipe(id, `idle ${Math.round((now - pipe.lastAccess) / 1000)}s — stopping pipeline`);
    }
  }
}, 15_000);

async function serveLiveFile(channelId: string, filename: string): Promise<Response> {
  const pipe = pipes.get(channelId);
  if (pipe) pipe.lastAccess = Date.now();
  if (filename.includes("/") || filename.includes("..")) {
    return new Response("bad path", { status: 400 });
  }
  const path = `${LIVE_DIR}/${channelId}/${filename}`;
  try {
    const f = await Deno.open(path, { read: true });
    const ct = filename.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : filename.endsWith(".mpd")
      ? "application/dash+xml"
      : filename.endsWith(".ts")
      ? "video/mp2t"
      : filename.endsWith(".m4s") || filename.endsWith(".mp4")
      ? "video/mp4"
      : "application/octet-stream";
    return new Response(f.readable, {
      headers: { "Content-Type": ct, "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// === Config store with mutex ===
let writeLock: Promise<unknown> = Promise.resolve();
let config: Config;

const emptyConfig: Config = {
  credentials: { username: "", password: "" },
  session: { token: null, uuid: null, issuedAt: null },
  channels: [],
  channelsUpdatedAt: null,
};

function migrateFromV1(data: { auth?: { username?: string; password?: string } }): Config {
  return {
    ...emptyConfig,
    credentials: { username: data.auth?.username ?? "", password: data.auth?.password ?? "" },
  };
}

async function loadConfig(): Promise<{ config: Config; mutated: boolean }> {
  try {
    const data = JSON.parse(await Deno.readTextFile(CONFIG_PATH));
    if (data.credentials) return { config: data, mutated: false };
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
  return config.channels;
}

// === HLS rewriting ===
function isM3u8(url: string, contentType: string | null): boolean {
  if (contentType?.includes("mpegurl")) return true;
  return /\.m3u8(\?|$)/i.test(url);
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

async function buildLivePlaylist(channelId: string, proxyOrigin: string): Promise<Response> {
  const info = await withAuth((t, u) => resolveStream(channelId, t, u));
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

// === Routing ===
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const host = req.headers.get("host") ?? `localhost:${PORT}`;

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
        const isDrmName = /drm|cetin|widevine/i.test(ch.name);
        const target = isDrmName
          ? (includeDrm ? `http://${host}/vlc/${ch.id}/index.m3u8` : null)
          : `http://${host}/live/${ch.id}.m3u8`;
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
    const requested = path.slice("/live/".length, -".m3u8".length);
    try {
      await getChannels();
      const ch = config.channels.find((c) => c.id === requested || c.slug === requested);
      if (!ch) return new Response(`unknown channel: ${requested}`, { status: 404 });
      return await buildLivePlaylist(ch.id, url.origin);
    } catch (e) {
      console.error(`[live] ${requested}:`, (e as Error).message);
      return new Response((e as Error).message, { status: 500 });
    }
  }

  // Debug: hex content keys from CDM sidecar. ?force=1 bypasses the cache.
  if (method === "GET" && path.startsWith("/api/keys/")) {
    const requested = path.slice("/api/keys/".length);
    try {
      await getChannels();
      const ch = config.channels.find((c) => c.id === requested || c.slug === requested);
      if (!ch) return Response.json({ error: `unknown channel: ${requested}` }, { status: 404 });
      const keys = await getKeys(ch.id, url.searchParams.get("force") === "1");
      return Response.json(keys);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // Server-decrypted HLS for VLC / IPTV apps. /vlc/<id>/index.m3u8 is the public playlist,
  // and sibling files in the working directory hold the decrypted local DASH view.
  if (method === "GET" && path.startsWith("/vlc/")) {
    const rest = path.slice("/vlc/".length);
    const slash = rest.indexOf("/");
    // /vlc/<id>.m3u8 → redirect to canonical /vlc/<id>/index.m3u8
    if (slash < 0 && rest.endsWith(".m3u8")) {
      const id = rest.slice(0, -".m3u8".length);
      return Response.redirect(`http://${host}/vlc/${id}/index.m3u8`, 302);
    }
    if (slash <= 0) return new Response("bad path", { status: 400 });
    const requested = rest.slice(0, slash);
    const filename = rest.slice(slash + 1);
    try {
      await getChannels();
      const ch = config.channels.find((c) => c.id === requested || c.slug === requested);
      if (!ch) return new Response(`unknown channel: ${requested}`, { status: 404 });
      // Only the playlist request triggers the pipeline startup; manifest and segment requests
      // are served from the existing per-channel working directory.
      if (filename === "index.m3u8") await ensurePipe(ch.id);
      return await serveLiveFile(ch.id, filename);
    } catch (e) {
      console.error(`[vlc] ${requested}/${filename}:`, (e as Error).message);
      return new Response((e as Error).message, { status: 500 });
    }
  }

  // JSON stream info for the in-browser player. For DRM channels, licenseUrl is /license/<id>
  // so the browser doesn't need the upstream Voyo bearer token.
  if (method === "GET" && path.startsWith("/api/stream/")) {
    const requested = path.slice("/api/stream/".length);
    try {
      await getChannels();
      const ch = config.channels.find((c) => c.id === requested || c.slug === requested);
      if (!ch) return Response.json({ error: `unknown channel: ${requested}` }, { status: 404 });
      const info = await getStreamInfo(ch.id);
      return Response.json({
        id: ch.id,
        name: ch.name,
        manifestUrl: info.url,
        isDrm: info.isDrm,
        licenseUrl: info.drm ? `/license/${ch.id}` : null,
      });
    } catch (e) {
      streamCache.delete(requested);
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // Widevine license proxy: forwards the challenge to Voyo's license server with the
  // saved Authorization headers, returns the binary license back to Shaka.
  if (method === "POST" && path.startsWith("/license/")) {
    const requested = path.slice("/license/".length);
    try {
      await getChannels();
      const ch = config.channels.find((c) => c.id === requested || c.slug === requested);
      if (!ch) return new Response(`unknown channel: ${requested}`, { status: 404 });
      let info = await getStreamInfo(ch.id);
      if (!info.drm) return new Response(`channel ${requested} is not DRM`, { status: 400 });
      const body = await req.arrayBuffer();
      let upstream = await fetch(info.drm.url, { method: "POST", headers: info.drm.headers, body });
      if (upstream.status === 401 || upstream.status === 403) {
        // Signed URL or token went stale — refresh once.
        info = await getStreamInfo(ch.id, true);
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
  const isDrm = (n) => /drm|cetin|widevine/i.test(n);
  rows.innerHTML = channels.map(c => {
    const drm = isDrm(c.name);
    const img = c.img ? '<img class="logo" src="' + c.img + '" loading="lazy" alt="">' : '';
    const lock = drm ? '<span class="lock" title="DRM — VLC link uses server-side decrypt via cdm.py">🔒</span>' : '';
    // For DRM channels the VLC-friendly URL is the server-decrypted /vlc/<id>/index.m3u8.
    const hls = drm ? '/vlc/' + c.id + '/index.m3u8' : '/live/' + c.id + '.m3u8';
    const play = '/play/' + c.id;
    return '<tr>' +
      '<td style="width:80px">' + img + '</td>' +
      '<td><label><input type="checkbox" class="pick" data-id="' + c.id + '" data-name="' + c.name + '"> <span class="name">' + c.name + '</span>' + lock + '</label></td>' +
      '<td class="actions">' +
        '<a href="' + play + '" target="_blank">▶ Play</a>' +
        '<a href="' + hls + '" target="_blank" data-url="' + hls + '">' + (drm ? '.m3u8 (VLC)' : '.m3u8') + '</a>' +
        '<button data-id="' + c.id + '" data-url="' + hls + '">📋 Copy URL</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}
rows.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const url = location.protocol + '//' + location.host + (btn.dataset.url || '/live/' + btn.dataset.id + '.m3u8');
  navigator.clipboard.writeText(url).then(() => toast('Copied: ' + url));
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
    const r = await fetch('/api/stream/' + encodeURIComponent(id));
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
  g.innerHTML = ids.map(id => '<iframe src="/play/' + encodeURIComponent(id) + '?embed=1" allow="autoplay; encrypted-media; microphone"></iframe>').join('');
}
</script>
</body>
</html>`;

// === Startup ===
{
  const loaded = await loadConfig();
  config = loaded.config;
  if (loaded.mutated) await saveConfig();
  console.log(`Voyo v2 → http://localhost:${PORT}`);
  if (!config.credentials.username) {
    console.log(`⚠  add credentials to ${CONFIG_PATH} then restart`);
  }
  Deno.serve({ port: PORT }, handle);
}
