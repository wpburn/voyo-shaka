#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

import requests


@dataclass
class ApiError(Exception):
    message: str
    status_code: Optional[int] = None
    payload: Optional[dict] = None

    def __str__(self) -> str:
        bits = [self.message]
        if self.status_code is not None:
            bits.append(f"HTTP {self.status_code}")
        return " - ".join(bits)


def _join_url(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _safe_filename(text: str, max_len: int = 160) -> str:
    t = re.sub(r"[^A-Za-z0-9._ -]+", "_", text).strip().strip(".")
    if not t:
        t = "item"
    return t[:max_len]


def _now() -> float:
    return time.time()


def cache_load(cache_path: str, ttl_s: int) -> Optional[dict]:
    try:
        st = os.stat(cache_path)
        if ttl_s > 0 and (_now() - st.st_mtime) > ttl_s:
            return None
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        return None


def cache_save(cache_path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
    tmp = cache_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, cache_path)


def _request_json(session: requests.Session, method: str, url: str, timeout: int = 20, **kwargs: Any) -> dict:
    r = session.request(method, url, timeout=timeout, **kwargs)
    if not r.ok:
        raise ApiError(f"Request failed: {url}", status_code=r.status_code)
    try:
        return r.json()
    except Exception:
        raise ApiError(f"Invalid JSON from: {url}", status_code=r.status_code)


def request_json_cached(
    session: requests.Session,
    method: str,
    url: str,
    cache_dir: Optional[str],
    ttl_s: int,
    timeout: int = 20,
    **kwargs: Any,
) -> dict:
    if not cache_dir:
        return _request_json(session, method, url, timeout=timeout, **kwargs)

    key_obj = {
        "method": method.upper(),
        "url": url,
        "kwargs": {
            k: kwargs.get(k)
            for k in sorted(kwargs.keys())
            if k in {"params", "headers", "data", "json"}
        },
    }
    key = _sha1(json.dumps(key_obj, sort_keys=True, ensure_ascii=False, default=str))
    cache_path = os.path.join(cache_dir, f"{key}.json")

    hit = cache_load(cache_path, ttl_s=ttl_s)
    if isinstance(hit, dict):
        return hit

    fresh = _request_json(session, method, url, timeout=timeout, **kwargs)
    if isinstance(fresh, dict):
        cache_save(cache_path, fresh)
    return fresh


def api_login(session: requests.Session, base_url: str, module: str) -> None:
    url = _join_url(base_url, f"/{module}/login")
    j = _request_json(session, "POST", url, headers={"content-type": "application/json"}, data="{}")
    if j.get("status") != "SUCCESS":
        raise ApiError("Login failed", payload=j)

    data = j.get("data")
    has_token = isinstance(data, list) and len(data) > 0 and bool(data[0])
    if not has_token:
        raise ApiError("Login returned no token", payload=j)


def api_updatechannels(session: requests.Session, base_url: str, module: str) -> None:
    url = _join_url(base_url, f"/{module}/updatechannels")
    j = _request_json(session, "GET", url)
    if j.get("status") != "SUCCESS":
        raise ApiError("updatechannels failed", payload=j)


def api_vod_page(
    session: requests.Session,
    base_url: str,
    module: str,
    page: int,
    search: Optional[str] = None,
    cache_dir: Optional[str] = None,
    cache_ttl_s: int = 0,
) -> dict:
    params = {"page": str(page)}
    if search:
        params["search"] = search
    url = _join_url(base_url, f"/{module}/vod")
    return request_json_cached(session, "GET", url, cache_dir=cache_dir, ttl_s=cache_ttl_s, params=params)


def api_show_episodes_page(
    session: requests.Session,
    base_url: str,
    module: str,
    show_id: str,
    page: int,
    cache_dir: Optional[str] = None,
    cache_ttl_s: int = 0,
) -> dict:
    url = _join_url(base_url, f"/{module}/vod/{show_id}")
    return request_json_cached(
        session,
        "GET",
        url,
        cache_dir=cache_dir,
        ttl_s=cache_ttl_s,
        params={"page": str(page)},
    )


def api_episode_stream(
    session: requests.Session,
    base_url: str,
    module: str,
    show_id: str,
    episode_id: str,
    cache_dir: Optional[str] = None,
    cache_ttl_s: int = 0,
) -> str:
    url = _join_url(base_url, f"/{module}/vod/{show_id}/{episode_id}")
    j = request_json_cached(session, "GET", url, cache_dir=cache_dir, ttl_s=cache_ttl_s)
    if j.get("status") != "SUCCESS":
        raise ApiError("Episode stream fetch failed", payload=j)
    data = j.get("data")
    if isinstance(data, dict) and isinstance(data.get("stream"), str) and data.get("stream"):
        return str(data.get("stream"))
    # sometimes server could return {data:{data:{stream}}} depending on wrappers; keep defensive
    if isinstance(data, dict) and isinstance(data.get("data"), dict) and isinstance(data["data"].get("stream"), str):
        return str(data["data"].get("stream"))
    raise ApiError("Episode stream missing in response", payload=j)


def iter_pages(fetch_page_fn, max_pages: Optional[int] = None, sleep_s: float = 0.0) -> Iterable[dict]:
    page = 1
    while True:
        j = fetch_page_fn(page)
        yield j

        data = j.get("data")
        if not isinstance(data, dict):
            # In this API wrapper, `data` is typically: { data: [...], pagination: {...} }
            # but we keep it defensive.
            break

        pagination = data.get("pagination") or {}
        total_pages = pagination.get("total_pages")
        current_page = pagination.get("current_page")

        if max_pages is not None and page >= max_pages:
            break

        if isinstance(total_pages, int) and isinstance(current_page, int):
            if current_page >= total_pages:
                break

        # Fallback: stop if no pagination exists
        if not pagination:
            break

        page += 1
        if sleep_s > 0:
            time.sleep(sleep_s)


def extract_shows(vod_page_response: dict) -> List[dict]:
    # Response wrapper: { status, module, data: { data: [...], pagination }, cache? }
    root = vod_page_response.get("data")
    if not isinstance(root, dict):
        raise ApiError("Unexpected /vod response shape", payload=vod_page_response)
    items = root.get("data")
    if not isinstance(items, list):
        raise ApiError("Unexpected /vod.data.data shape", payload=vod_page_response)
    out: List[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        out.append(it)
    return out


def group_by_category(shows: List[dict]) -> Dict[str, List[dict]]:
    grouped: Dict[str, List[dict]] = {}
    for s in shows:
        cat = (s.get("category") or "unknown")
        if not isinstance(cat, str) or not cat.strip():
            cat = "unknown"
        grouped.setdefault(cat, []).append(s)
    # deterministic output
    for k in list(grouped.keys()):
        grouped[k] = sorted(grouped[k], key=lambda x: (str(x.get("name") or ""), str(x.get("id") or "")))
    return dict(sorted(grouped.items(), key=lambda kv: kv[0]))


def _parse_season_episode(title: str) -> Dict[str, Optional[int]]:
    t = (title or "").strip()
    # common patterns: S01E02, s1e2
    m = re.search(r"\bS(?P<s>\d{1,2})\s*E(?P<e>\d{1,3})\b", t, flags=re.IGNORECASE)
    if m:
        return {"season": int(m.group("s")), "episode": int(m.group("e"))}

    # Romanian: Sezonul 1 Episodul 2 / Sezon 1 Ep 2
    m = re.search(
        r"\bsezon(?:ul)?\s*(?P<s>\d{1,2})\b.*?\b(ep(?:isod(?:ul)?)?|ep\.)\s*(?P<e>\d{1,3})\b",
        t,
        flags=re.IGNORECASE,
    )
    if m:
        return {"season": int(m.group("s")), "episode": int(m.group("e"))}

    # Sometimes only episode number present: Ep 12
    m = re.search(r"\b(ep(?:isod(?:ul)?)?|ep\.)\s*(?P<e>\d{1,3})\b", t, flags=re.IGNORECASE)
    if m:
        return {"season": None, "episode": int(m.group("e"))}

    return {"season": None, "episode": None}


def classify_show_kind(episodes_count: int) -> str:
    # heuristic requested by user: films tend to have a single correspondence
    return "film" if episodes_count <= 1 else "serial"


def build_library(
    shows: List[dict],
    episodes_by_show: Dict[str, List[dict]],
    include_streams: bool,
    streams_by_episode: Dict[str, str],
) -> dict:
    # Output: categories -> kind -> show -> seasons -> episodes
    grouped = group_by_category(shows)
    out: Dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "categories": {},
    }

    for category, cat_shows in grouped.items():
        cat_obj: Dict[str, Any] = {"filme": [], "seriale": []}
        for s in cat_shows:
            show_id = str(s.get("id") or "")
            show_name = str(s.get("name") or "")
            show_eps = episodes_by_show.get(show_id, [])
            kind = classify_show_kind(len(show_eps))

            if kind == "film":
                film_item = {
                    "id": show_id,
                    "name": show_name,
                    "category": s.get("category"),
                    "categoryRaw": s.get("categoryRaw"),
                    "img": s.get("img"),
                    "link": s.get("link"),
                    "episode": None,
                }
                if len(show_eps) == 1:
                    ep = show_eps[0]
                    epid = str(ep.get("id") or "")
                    ep_item = {
                        "id": epid,
                        "name": ep.get("name"),
                        "date": ep.get("date"),
                        "link": ep.get("link"),
                    }
                    if include_streams and epid:
                        ep_item["stream"] = streams_by_episode.get(f"{show_id}:{epid}")
                    film_item["episode"] = ep_item
                cat_obj["filme"].append(film_item)
            else:
                seasons: Dict[str, Any] = {}
                for ep in show_eps:
                    epid = str(ep.get("id") or "")
                    parsed = _parse_season_episode(str(ep.get("name") or ""))
                    season_num = parsed["season"]
                    episode_num = parsed["episode"]
                    season_key = str(season_num if season_num is not None else 1)
                    seasons.setdefault(
                        season_key,
                        {"season": int(season_key), "episodes": []},
                    )
                    ep_item = {
                        "id": epid,
                        "name": ep.get("name"),
                        "date": ep.get("date"),
                        "link": ep.get("link"),
                        "episode": episode_num,
                    }
                    if include_streams and epid:
                        ep_item["stream"] = streams_by_episode.get(f"{show_id}:{epid}")
                    seasons[season_key]["episodes"].append(ep_item)

                # sort episodes
                for sk in list(seasons.keys()):
                    seasons[sk]["episodes"] = sorted(
                        seasons[sk]["episodes"],
                        key=lambda x: (
                            999999 if x.get("episode") is None else int(x.get("episode")),
                            str(x.get("date") or ""),
                            str(x.get("id") or ""),
                        ),
                    )

                serial_item = {
                    "id": show_id,
                    "name": show_name,
                    "category": s.get("category"),
                    "categoryRaw": s.get("categoryRaw"),
                    "img": s.get("img"),
                    "link": s.get("link"),
                    "seasons": [seasons[k] for k in sorted(seasons.keys(), key=lambda x: int(x))],
                }
                cat_obj["seriale"].append(serial_item)

        out["categories"][category] = cat_obj

    return out


def ffmpeg_remux_to_mp4(m3u8_url: str, out_path: str, ffmpeg_bin: str = "ffmpeg") -> None:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    # Best-effort: remux HLS to MP4 without re-encoding.
    # Note: if the stream uses DRM, ffmpeg will fail.
    cmd = [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        m3u8_url,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        out_path,
    ]
    subprocess.run(cmd, check=True)


def write_json(path: str, payload: Any) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def write_csv(path: str, shows: List[dict]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fields = ["id", "name", "date", "category", "categoryRaw", "link", "img"]
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for s in shows:
            row = {k: s.get(k, "") for k in fields}
            w.writerow(row)


def main() -> int:
    ap = argparse.ArgumentParser(description="Export IPTVRO VOD list and group by category")
    ap.add_argument("--base-url", default=os.environ.get("IPTVRO_BASE_URL", "http://127.0.0.1:8090"))
    ap.add_argument("--module", default=os.environ.get("IPTVRO_MODULE", "antena-play"))
    ap.add_argument("--out-dir", default="out")
    ap.add_argument("--search", default=None, help="Optional search query (server-side search)")
    ap.add_argument("--max-pages", type=int, default=None, help="Limit pages (debug/testing)")
    ap.add_argument("--sleep", type=float, default=0.15, help="Sleep between page requests")
    ap.add_argument("--cache-dir", default=os.environ.get("IPTVRO_CACHE_DIR", "out/.cache"))
    ap.add_argument(
        "--cache-ttl",
        type=int,
        default=int(os.environ.get("IPTVRO_CACHE_TTL", "21600")),
        help="Cache TTL in seconds (default 6h). Set 0 to disable expiry.",
    )
    ap.add_argument("--no-cache", action="store_true", help="Disable disk cache.")
    ap.add_argument(
        "--with-episodes",
        action="store_true",
        help="Also fetch episodes for each show (can be slow).",
    )
    ap.add_argument(
        "--episodes-max-pages",
        type=int,
        default=0,
        help="Max pages per show when --with-episodes (0 = all pages)",
    )
    ap.add_argument(
        "--with-streams",
        action="store_true",
        help="Also fetch stream URL for each episode (extra requests).",
    )
    ap.add_argument(
        "--download-mp4",
        action="store_true",
        help="Use ffmpeg to download/remux episodes to MP4 (requires --with-streams).",
    )
    ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"), help="ffmpeg binary path")
    ap.add_argument(
        "--media-dir",
        default=os.environ.get("IPTVRO_MEDIA_DIR", "out/media"),
        help="Output folder for MP4 files when --download-mp4",
    )
    ap.add_argument(
        "--max-downloads",
        type=int,
        default=0,
        help="Limit number of MP4 downloads (0 = no limit)",
    )

    args = ap.parse_args()

    base_url: str = args.base_url
    module: str = args.module

    session = requests.Session()

    try:
        api_login(session, base_url, module)
        api_updatechannels(session, base_url, module)

        all_shows: List[dict] = []
        cache_dir: Optional[str] = None if args.no_cache else str(args.cache_dir)
        cache_ttl_s: int = int(args.cache_ttl)

        def fetch(page: int) -> dict:
            return api_vod_page(
                session,
                base_url,
                module,
                page=page,
                search=args.search,
                cache_dir=cache_dir,
                cache_ttl_s=cache_ttl_s,
            )

        for page_json in iter_pages(fetch, max_pages=args.max_pages, sleep_s=args.sleep):
            all_shows.extend(extract_shows(page_json))

        # De-dup by id
        uniq: Dict[str, dict] = {}
        for s in all_shows:
            sid = str(s.get("id") or "")
            if sid:
                uniq[sid] = s
        shows = list(uniq.values())
        shows = sorted(shows, key=lambda x: (str(x.get("category") or ""), str(x.get("name") or "")))

        out_dir = args.out_dir
        write_json(os.path.join(out_dir, f"{module}_vod_shows.json"), shows)
        grouped = group_by_category(shows)
        write_json(os.path.join(out_dir, f"{module}_vod_by_category.json"), grouped)
        write_csv(os.path.join(out_dir, f"{module}_vod_shows.csv"), shows)

        episodes_by_show: Dict[str, List[dict]] = {}
        streams_by_episode: Dict[str, str] = {}

        if args.with_episodes or args.with_streams or args.download_mp4:
            # Fetch episodes list per show (cached)
            for idx, s in enumerate(shows, start=1):
                show_id = str(s.get("id") or "")
                if not show_id:
                    continue

                eps: List[dict] = []

                def fetch_eps(p: int) -> dict:
                    return api_show_episodes_page(
                        session,
                        base_url,
                        module,
                        show_id,
                        page=p,
                        cache_dir=cache_dir,
                        cache_ttl_s=cache_ttl_s,
                    )

                ep_max_pages: Optional[int] = None if int(args.episodes_max_pages) == 0 else int(args.episodes_max_pages)
                for page_json in iter_pages(fetch_eps, max_pages=ep_max_pages, sleep_s=args.sleep):
                    root = page_json.get("data")
                    if not isinstance(root, dict):
                        break
                    data = root.get("data")
                    if isinstance(data, list):
                        eps.extend([e for e in data if isinstance(e, dict)])

                episodes_by_show[show_id] = eps

                if idx % 25 == 0:
                    print(f"Fetched episodes for {idx}/{len(shows)} shows...", file=sys.stderr)

            write_json(os.path.join(out_dir, f"{module}_vod_episodes_by_show.json"), {
                k: {"episodes": v} for k, v in episodes_by_show.items()
            })

        if args.with_streams or args.download_mp4:
            # Fetch stream URL per episode (cached)
            for show_id, eps in episodes_by_show.items():
                for ep in eps:
                    epid = str(ep.get("id") or "")
                    if not epid:
                        continue
                    key = f"{show_id}:{epid}"
                    if key in streams_by_episode:
                        continue
                    streams_by_episode[key] = api_episode_stream(
                        session,
                        base_url,
                        module,
                        show_id,
                        epid,
                        cache_dir=cache_dir,
                        cache_ttl_s=cache_ttl_s,
                    )
                    if args.sleep > 0:
                        time.sleep(args.sleep)

            write_json(os.path.join(out_dir, f"{module}_vod_streams_by_episode.json"), streams_by_episode)

        library = build_library(
            shows=shows,
            episodes_by_show=episodes_by_show,
            include_streams=bool(args.with_streams or args.download_mp4),
            streams_by_episode=streams_by_episode,
        )
        write_json(os.path.join(out_dir, f"{module}_vod_library.json"), library)

        if args.download_mp4:
            if not args.with_streams and not streams_by_episode:
                raise ApiError("--download-mp4 requires --with-streams")

            downloaded = 0
            for show_id, eps in episodes_by_show.items():
                show = next((s for s in shows if str(s.get("id")) == show_id), None)
                show_name = str((show or {}).get("name") or show_id)
                for ep in eps:
                    epid = str(ep.get("id") or "")
                    if not epid:
                        continue
                    stream = streams_by_episode.get(f"{show_id}:{epid}")
                    if not stream:
                        continue

                    ep_name = str(ep.get("name") or epid)
                    fname = _safe_filename(f"{show_name} - {ep_name}.mp4")
                    out_path = os.path.join(str(args.media_dir), fname)
                    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                        continue

                    ffmpeg_remux_to_mp4(stream, out_path=out_path, ffmpeg_bin=str(args.ffmpeg))
                    downloaded += 1
                    if args.max_downloads and downloaded >= int(args.max_downloads):
                        break
                    if args.sleep > 0:
                        time.sleep(args.sleep)
                if args.max_downloads and downloaded >= int(args.max_downloads):
                    break

        print(f"OK: exported {len(shows)} shows to: {out_dir}")
        print(f" - {os.path.join(out_dir, f'{module}_vod_shows.json')}")
        print(f" - {os.path.join(out_dir, f'{module}_vod_by_category.json')}")
        print(f" - {os.path.join(out_dir, f'{module}_vod_shows.csv')}")
        if args.with_episodes or args.with_streams or args.download_mp4:
            print(f" - {os.path.join(out_dir, f'{module}_vod_episodes_by_show.json')}")
            print(f" - {os.path.join(out_dir, f'{module}_vod_library.json')}")
        if args.with_streams or args.download_mp4:
            print(f" - {os.path.join(out_dir, f'{module}_vod_streams_by_episode.json')}")
        if args.download_mp4:
            print(f" - media: {args.media_dir}")

        return 0

    except ApiError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        if e.payload:
            try:
                print(json.dumps(e.payload, ensure_ascii=False, indent=2)[:2000], file=sys.stderr)
            except Exception:
                pass
        return 2
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
