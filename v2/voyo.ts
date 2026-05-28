#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
// Voyo Live — single-file Deno 2 server.
// Routes:  GET /  • GET /api/channels  • POST /api/login  • GET /live/:id.m3u8  • GET /live.m3u8  • GET /proxy?url=

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

function rewritePlaylist(body: string, baseUrl: string): string {
  const proxy = (abs: string) => `/proxy?url=${encodeURIComponent(abs)}`;
  return body.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (line.startsWith("#")) {
      // rewrite URI="..." attributes inside tags (keys, maps, etc.)
      return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxy(new URL(u, baseUrl).toString())}"`);
    }
    return proxy(new URL(line, baseUrl).toString());
  }).join("\n");
}

async function buildLivePlaylist(channelId: string): Promise<Response> {
  const info = await withAuth((t, u) => resolveStream(channelId, t, u));
  if (info.isDrm) {
    return new Response(`channel ${channelId} is DRM (DASH+Widevine); not supported by this proxy`, { status: 415 });
  }
  const masterRes = await fetch(info.url);
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
      const varRes = await fetch(baseUrl);
      if (!varRes.ok) return new Response(`variant ${varRes.status}`, { status: varRes.status });
      body = await varRes.text();
    }
  }

  return new Response(rewritePlaylist(body, baseUrl), {
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
    try {
      const channels = await getChannels();
      const lines = ["#EXTM3U"];
      for (const ch of channels) {
        lines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-logo="${ch.img}" group-title="Voyo",${ch.name}`);
        lines.push(`http://${host}/live/${ch.id}.m3u8`);
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
      return await buildLivePlaylist(ch.id);
    } catch (e) {
      console.error(`[live] ${requested}:`, (e as Error).message);
      return new Response((e as Error).message, { status: 500 });
    }
  }

  if (method === "GET" && path === "/proxy") {
    const target = url.searchParams.get("url");
    if (!target) return new Response("missing url", { status: 400 });
    try {
      const upstream = await fetch(target);
      const ct = upstream.headers.get("content-type");
      if (isM3u8(target, ct)) {
        const body = await upstream.text();
        return new Response(rewritePlaylist(body, target), {
          status: upstream.status,
          headers: { "Content-Type": ct ?? "application/vnd.apple.mpegurl" },
        });
      }
      const headers = new Headers();
      if (ct) headers.set("Content-Type", ct);
      const len = upstream.headers.get("content-length");
      if (len) headers.set("Content-Length", len);
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
    const img = c.img ? '<img class="logo" src="' + c.img + '" loading="lazy" alt="">' : '';
    const lock = isDrm(c.name) ? '<span class="lock" title="Has DRM (may not play in VLC)">🔒</span>' : '';
    const url = '/live/' + c.id + '.m3u8';
    return '<tr>' +
      '<td style="width:80px">' + img + '</td>' +
      '<td><span class="name">' + c.name + '</span>' + lock + '</td>' +
      '<td class="actions"><a href="' + url + '" target="_blank">open</a><button data-id="' + c.id + '">📋 Copy URL</button></td>' +
    '</tr>';
  }).join('');
}
rows.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const url = location.protocol + '//' + location.host + '/live/' + btn.dataset.id + '.m3u8';
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
load(false);
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
