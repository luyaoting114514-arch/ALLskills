#!/usr/bin/env python3
"""Build the SkillAtlas dataset from real GitHub repositories.

Phases are resumable and cached, because unauthenticated GitHub allows only
10 search requests/minute and 60 core requests/hour.

    python tools/collect_skills.py search    # GitHub Search API -> data/raw_repos.json
    python tools/collect_skills.py verify    # git tree API -> data/verify_cache.json
    python tools/collect_skills.py emit      # -> data/skills.json + data/skills.js
    python tools/collect_skills.py all

Set GITHUB_TOKEN or GH_TOKEN to lift both rate limits substantially.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_FILE = DATA_DIR / "raw_repos.json"
CACHE_FILE = DATA_DIR / "verify_cache.json"

UA = "skillatlas-collector/3.0"
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
HEADERS = {
    "User-Agent": UA,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}
if TOKEN:
    HEADERS["Authorization"] = f"Bearer {TOKEN}"

SEARCH_QUERIES: list[tuple[str, str, int]] = [
    ("topic:claude-skills", "stars", 3),
    ("topic:agent-skills", "stars", 3),
    ("topic:claude-code-skills", "stars", 2),
    ("claude skills in:name,description", "stars", 3),
    ("agent skills in:name,description", "stars", 3),
    ("SKILL.md in:readme", "stars", 3),
    ("claude skills in:readme", "stars", 2),
    ("awesome claude skills in:name,description", "stars", 2),
    ("awesome agent skills in:name,description", "stars", 2),
    ("topic:ai-skills", "stars", 2),
    ("topic:codex-skills", "stars", 2),
    ("topic:claude-code", "stars", 2),
    ("topic:mcp-server", "stars", 2),
    ("topic:model-context-protocol", "stars", 2),
    ("topic:claude", "stars", 2),
    ("claude code plugin in:name,description", "stars", 2),
    ("ai agent toolkit in:name,description", "stars", 2),
    ("prompt library agent in:name,description", "stars", 2),
    ("topic:awesome-claude-skills", "stars", 2),
]

# Search pacing depends on the quota we actually have: anonymous tokens allow
# 10 search requests/minute, an authenticated token allows 30. Sleeping 7.2s
# between calls when a token is present wastes roughly two thirds of the run.
SEARCH_PAUSE = 2.2 if TOKEN else 7.2

RATE = {"search_remaining": 10, "search_reset": 0.0, "core_remaining": 60, "core_reset": 0.0}
RATE_LOCK = threading.Lock()


def rate_get(key: str) -> float:
    with RATE_LOCK:
        return RATE[key]


def rate_set(**kwargs) -> None:
    with RATE_LOCK:
        RATE.update(kwargs)


def log(message: str) -> None:
    print(message, flush=True)


def sleep_until(timestamp: float, cap: float = 70.0) -> None:
    delta = timestamp - time.time()
    if delta > 0:
        time.sleep(min(delta + 1.0, cap))


def api_get(url: str, bucket: str, timeout: int = 20, retries: int = 2):
    remaining_key = f"{bucket}_remaining"
    reset_key = f"{bucket}_reset"
    for attempt in range(retries):
        if rate_get(remaining_key) <= 1:
            log(f"  [rate] {bucket} exhausted, waiting {max(rate_get(reset_key) - time.time(), 0):.0f}s")
            sleep_until(rate_get(reset_key))
            if bucket == "search":
                time.sleep(2.0)  # let the window roll over before retrying
            rate_set(**{remaining_key: 5 if bucket == "search" else 50})
        request = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                updates = {}
                if response.headers.get("x-ratelimit-remaining") is not None:
                    updates[remaining_key] = int(response.headers["x-ratelimit-remaining"])
                if response.headers.get("x-ratelimit-reset") is not None:
                    updates[reset_key] = float(response.headers["x-ratelimit-reset"])
                if updates:
                    rate_set(**updates)
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return "404"
            if exc.code in (403, 429):
                if exc.headers.get("x-ratelimit-reset"):
                    rate_set(**{reset_key: float(exc.headers["x-ratelimit-reset"])})
                rate_set(**{remaining_key: 0})
                log(f"  [rate] {exc.code} on {bucket} (attempt {attempt + 1}/{retries})")
                sleep_until(rate_get(reset_key))
                if bucket == "search":
                    time.sleep(2.0)
                continue
            return None
        except (socket.timeout, TimeoutError):
            log("  [net] timeout")
            return "TIMEOUT"
        except Exception:
            time.sleep(1.5)
    return None


# ---------------------------------------------------------------- search

def phase_search(pages: int, min_stars: int) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing = {}
    if RAW_FILE.exists():
        try:
            previous = json.loads(RAW_FILE.read_text(encoding="utf-8"))
            existing = {r["full_name"]: r for r in previous.get("repos", [])}
            log(f"loaded {len(existing)} cached repositories")
        except Exception:
            existing = {}

    found = dict(existing)
    request_index = 0
    for query, sort, query_pages in SEARCH_QUERIES:
        for page in range(1, min(query_pages, pages) + 1):
            if request_index:
                # Keep a margin below the real quota so a query is never skipped
                # by a stale reset timestamp.
                time.sleep(SEARCH_PAUSE)
            request_index += 1
            url = (
                "https://api.github.com/search/repositories"
                f"?q={urllib.parse.quote(query + ' fork:false')}"
                f"&sort={sort}&order=desc&per_page=100&page={page}"
            )
            data = api_get(url, "search", timeout=25)
            if not isinstance(data, dict) or not data.get("items"):
                if data == "TIMEOUT":
                    log(f"  [search] {query!r} p{page}: timeout, skipping")
                    continue
                break
            added = 0
            for item in data["items"]:
                key = item["full_name"]
                if key not in found:
                    added += 1
                previous = found.get(key)
                if previous is None or (item.get("stargazers_count") or 0) >= (previous.get("stargazers_count") or 0):
                    found[key] = item
            log(f"  [search] {query!r} p{page}: +{added} (unique {len(found)})")
            if len(data["items"]) < 100:
                break

    repos = [r for r in found.values() if (r.get("stargazers_count") or 0) >= min_stars]
    RAW_FILE.write_text(
        json.dumps(
            {"fetchedAt": datetime.now(timezone.utc).isoformat(), "repos": repos},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    log(f"saved {len(repos)} repositories (>= {min_stars} stars) to {RAW_FILE.name}")
    return {"repos": repos}


# ---------------------------------------------------------------- verify

TREE_URL = "https://api.github.com/repos/{full}/git/trees/{branch}?recursive=1"
MAX_REPO_KB = 400_000  # skip repos larger than ~400 MB: file trees are huge and rarely skill collections


def tree_skill_count(repo: dict):
    branch = repo.get("default_branch") or "main"
    data = api_get(TREE_URL.format(full=repo["full_name"], branch=branch), "core", timeout=25)
    if data == "404":
        return 0
    if not isinstance(data, dict) or "tree" not in data:
        return None
    return sum(1 for node in data["tree"] if node.get("type") == "blob" and is_skill_file(node.get("path")))


def is_skill_file(path) -> bool:
    """True only for files literally named SKILL.md (any directory, any case)."""
    name = str(path or "").rsplit("/", 1)[-1]
    return name.lower() == "skill.md"


def phase_verify(budget: int, min_stars: int, recheck: bool = False, recheck_below: int = -1,
                 targets: str = "", workers: int = 8) -> dict:
    if not RAW_FILE.exists():
        log("run the search phase first")
        return {}
    repos = json.loads(RAW_FILE.read_text(encoding="utf-8"))["repos"]
    cache = {}
    if CACHE_FILE.exists():
        cache = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    target_set = {t.strip() for t in targets.split(",") if t.strip()}
    if target_set:
        for key in list(cache):
            if key in target_set:
                cache.pop(key, None)
        log(f"targeted re-verification of {len(target_set)} repositories")
    elif recheck:
        cache = {}
        log("recheck enabled: ignoring cached verification results")
    elif recheck_below >= 0:
        stale = [k for k, v in cache.items() if (v.get("skillCount") or 0) <= recheck_below]
        for key in stale:
            cache.pop(key, None)
        log(f"rechecking {len(stale)} repositories with <= {recheck_below} SKILL.md")
    # Verify smaller, more recent, more starred repos first: they are the most
    # likely to be genuine skill collections and they return fast.
    if target_set:
        pending = [r for r in repos if r["full_name"] in target_set and r["full_name"] not in cache]
    else:
        pending = [
            r
            for r in repos
            if r["full_name"] not in cache
            and (r.get("stargazers_count") or 0) >= min_stars
            and (r.get("size") or 0) <= MAX_REPO_KB
            and not r.get("archived")
        ]
        pending.sort(key=lambda r: (-(r.get("stargazers_count") or 0), r.get("size") or 0))
    log(f"{len(pending)} repositories pending verification")

    # A token-backed Actions run has ample core quota. Run independent tree
    # requests concurrently, while keeping the anonymous path conservative.
    # The cache is only written by the main thread so interrupted runs remain
    # valid JSON and can resume safely.
    if budget <= 0 or rate_get("core_remaining") <= 2:
        log("  [verify] budget/quota guard before starting")
        return cache
    batch = pending[:budget]
    worker_count = max(1, min(int(workers or 1), len(batch), 16))
    log(f"  [verify] checking {len(batch)} repositories with {worker_count} workers")

    def work(repo):
        try:
            return repo, tree_skill_count(repo)
        except Exception as exc:
            log(f"  [verify] {repo['full_name']}: {type(exc).__name__}")
            return repo, None

    checked = 0
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        for repo, count in pool.map(work, batch):
            checked += 1
            cache[repo["full_name"]] = {
                "skillCount": count,
                "error": count is None,
                "checkedAt": datetime.now(timezone.utc).isoformat(),
            }
            if count:
                log(f"  [verify] {repo['full_name']}: {count} SKILL.md")
            if checked % 10 == 0:
                CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    verified = sum(1 for v in cache.values() if (v.get("skillCount") or 0) > 0)
    log(f"checked {checked} this run; {verified} verified repositories cached")
    return cache


# ---------------------------------------------------------------- scan (jsDelivr)
#
# GitHub's Git Tree API is authoritative but limited to 60 requests/hour
# anonymously. jsDelivr mirrors the same file listing over a CDN with no
# practical quota, so we use it as a wide-coverage second source and keep the
# GitHub count whenever we have it.

JSDELIVR_FILE = DATA_DIR / "jsdelivr_cache.json"
JSDELIVR_URL = "https://data.jsdelivr.com/v1/packages/gh/{full}@{branch}"


def _walk_skill_files(nodes, prefix="") -> int:
    total = 0
    for node in nodes or []:
        path = prefix + "/" + str(node.get("name", ""))
        if node.get("type") == "directory":
            total += _walk_skill_files(node.get("files"), path)
        elif is_skill_file(path):
            total += 1
    return total


def jsdelivr_scan(repo: dict):
    branch = repo.get("default_branch") or "main"
    request = urllib.request.Request(
        JSDELIVR_URL.format(full=repo["full_name"], branch=branch),
        headers={"User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return _walk_skill_files(json.loads(response.read().decode("utf-8")).get("files"))
    except urllib.error.HTTPError as exc:
        return "MISS" if exc.code == 404 else None
    except Exception:
        return None


def phase_scan(workers: int, min_stars: int) -> dict:
    from concurrent.futures import ThreadPoolExecutor

    repos = json.loads(RAW_FILE.read_text(encoding="utf-8"))["repos"]
    cache = json.loads(JSDELIVR_FILE.read_text(encoding="utf-8")) if JSDELIVR_FILE.exists() else {}
    pending = [
        r for r in repos
        if r["full_name"] not in cache and (r.get("stargazers_count") or 0) >= min_stars
    ]
    log(f"{len(pending)} repositories pending jsDelivr scan")
    done = 0
    hits = 0

    def work(repo):
        return repo["full_name"], jsdelivr_scan(repo)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for full_name, count in pool.map(work, pending):
            done += 1
            if count == "MISS":
                cache[full_name] = {"skillCount": None, "source": "jsdelivr", "miss": True,
                                    "checkedAt": datetime.now(timezone.utc).isoformat()}
            elif count is None:
                cache[full_name] = {"skillCount": None, "source": "jsdelivr", "error": True,
                                    "checkedAt": datetime.now(timezone.utc).isoformat()}
            else:
                cache[full_name] = {"skillCount": count, "source": "jsdelivr",
                                    "checkedAt": datetime.now(timezone.utc).isoformat()}
                if count:
                    hits += 1
            if done % 100 == 0:
                JSDELIVR_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
                log(f"  [scan] {done}/{len(pending)} done, {hits} with SKILL.md")

    JSDELIVR_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    total_hits = sum(1 for v in cache.values() if (v.get("skillCount") or 0) > 0)
    log(f"scanned {done} this run; {total_hits} repositories have SKILL.md (jsDelivr)")
    return cache


# ---------------------------------------------------------------- emit

CATEGORY_RULES = [
    ("文档办公", r"docx|pptx|xlsx|powerpoint|spreadsheet|slides|\bdeck\b|office|word|excel|\bpdf\b"),
    ("科研学术", r"research|paper|arxiv|literature|citation|\bcite\b|academic|thesis|scientific|pubmed"),
    ("生物医药", r"genom|protein|bioinform|chemi|\bdrug\b|rnaseq|scanpy|clinical|biolog|medical"),
    ("数据科学", r"\bdata\b|analytics|pandas|\bsql\b|database|warehouse|\betl\b|visuali[sz]|chart|analysis"),
    ("浏览器自动化", r"browser|playwright|puppeteer|scrap|crawl|selenium|web automation"),
    ("设计创意", r"design|figma|image|video|audio|music|creative|brand|\bsvg\b|three|3d|\bui\b|\bux\b"),
    ("写作内容", r"writ|blog|copywrit|content|translat|summar|editor|\bseo\b|newsletter"),
    ("集成连接", r"\bmcp\b|integration|connector|slack|notion|linear|jira|\bapi\b|server"),
    ("编程开发", r"\bcode\b|coding|develop|program|\bgit\b|review|refactor|test|debug|\bide\b|lint|typescript|python"),
    ("效率工具", r"productiv|workflow|automat|\btask\b|\bnote\b|calendar|email|organi[sz]e|todo"),
    ("Agent 框架", r"framework|orchestrat|\bagent\b|swarm|router|runtime|harness|subagent|skill"),
]

ICONS = {
    "文档办公": ("\u25a3", "icon-teal"), "科研学术": ("\u2726", "icon-violet"),
    "生物医药": ("\u2301", "icon-teal"), "数据科学": ("\u25cc", "icon-blue"),
    "浏览器自动化": ("\u25c8", "icon-orange"), "设计创意": ("\u25d0", "icon-orange"),
    "写作内容": ("\u270e", "icon-violet"), "集成连接": ("\u21c4", "icon-blue"),
    "编程开发": ("\u2318", "icon-blue"), "效率工具": ("\u25f7", "icon-violet"),
    "Agent 框架": ("\u2727", "icon-teal"), "其他": ("\u2022", "icon-blue"),
}


def classify(repo: dict) -> str:
    haystack = " ".join(
        [str(repo.get("name") or ""), str(repo.get("description") or ""), " ".join(repo.get("topics") or [])]
    ).lower()
    for label, pattern in CATEGORY_RULES:
        if re.search(pattern, haystack):
            return label
    return "其他"


def days_since(iso: str | None, floor: float = 0.5) -> float:
    if not iso:
        return 3650.0
    try:
        moment = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return 3650.0
    return max((datetime.now(timezone.utc) - moment).total_seconds() / 86400.0, floor)


def trend_score(repo: dict) -> float:
    stars = repo.get("stargazers_count") or 0
    forks = repo.get("forks_count") or 0
    age = days_since(repo.get("created_at"))
    pushed = days_since(repo.get("pushed_at"), floor=0.2)
    return round(stars * 0.45 + (stars / age) * 55.0 + forks * 0.5 + (1.0 / (1.0 + pushed / 21.0)) * 25.0, 2)


def build_record(repo: dict, entry: dict) -> dict:
    category = classify(repo)
    icon, icon_class = ICONS.get(category, ICONS["其他"])
    stars = repo.get("stargazers_count") or 0
    age = days_since(repo.get("created_at"))
    skill_count = entry.get("skillCount") if entry else None
    source = entry.get("source") if entry else None
    return {
        "id": repo["full_name"],
        "name": repo.get("name") or repo["full_name"].split("/")[-1],
        "owner": (repo.get("owner") or {}).get("login") or repo["full_name"].split("/")[0],
        "fullName": repo["full_name"],
        "url": repo.get("html_url"),
        "homepage": repo.get("homepage") or "",
        "description": (repo.get("description") or "").strip(),
        "category": category,
        "topics": [t for t in (repo.get("topics") or []) if t][:8],
        "language": repo.get("language") or "",
        "license": ((repo.get("license") or {}) or {}).get("spdx_id") or "",
        "stars": stars,
        "forks": repo.get("forks_count") or 0,
        "openIssues": repo.get("open_issues_count") or 0,
        "createdAt": repo.get("created_at"),
        "pushedAt": repo.get("pushed_at"),
        "sizeKb": repo.get("size") or 0,
        "ageDays": round(age, 1),
        "starsPerDay": round(stars / age, 3),
        "archived": bool(repo.get("archived")),
        "skillCount": skill_count,
        "verified": bool(skill_count and skill_count > 0),
        "verifiedAt": entry.get("checkedAt") if entry else None,
        "verifiedSource": source,
        "trendScore": trend_score(repo),
        "icon": icon,
        "iconClass": icon_class,
        "avatar": ((repo.get("owner") or {}).get("avatar_url") or ""),
    }


# Broad-star queries inevitably pull in unrelated mega-repos, so keep only
# repositories that either ship a SKILL.md or say what they are in plain words.
AI_SIGNAL = re.compile(
    r"(?:\bai\b|\bagents?\b|llm|\bclaude\b|\bgpt\b|codex|skills?\b|prompts?\b|\bmcp\b|"
    r"copilot|model[- ]context|openai|anthropic|gemini|cursor|chatbot|rag\b)",
    re.IGNORECASE,
)


def is_relevant(record: dict) -> bool:
    if record["verified"]:
        return True
    haystack = " ".join(
        [record["name"], record["description"], " ".join(record["topics"]), record["category"]]
    )
    return bool(AI_SIGNAL.search(haystack))


SKILL_WORD = re.compile(r"\bskills?\b|agent[- ]skill|claude[- ]skill|skill[- ]pack", re.IGNORECASE)


def has_skill_signal(record: dict) -> bool:
    if record["verified"]:
        return True
    return bool(SKILL_WORD.search(" ".join([record["name"], record["description"], " ".join(record["topics"])])))


def phase_emit(min_stars: int) -> dict:
    repos = json.loads(RAW_FILE.read_text(encoding="utf-8"))["repos"]
    cache = json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else {}
    jcache = json.loads(JSDELIVR_FILE.read_text(encoding="utf-8")) if JSDELIVR_FILE.exists() else {}

    def merged(full_name: str) -> dict:
        """Prefer the authoritative GitHub tree count, fall back to the jsDelivr mirror."""
        github = cache.get(full_name) or {}
        if github.get("skillCount") is not None:
            return {**github, "source": "github-tree"}
        mirror = jcache.get(full_name) or {}
        if mirror.get("skillCount") is not None:
            return {**mirror, "source": "jsdelivr"}
        return {}

    repos = [r for r in repos if (r.get("stargazers_count") or 0) >= min_stars]
    records = [build_record(r, merged(r["full_name"])) for r in repos]
    before = len(records)
    records = [r for r in records if is_relevant(r)]
    log(f"relevance filter: {before} -> {len(records)}")
    for record in records:
        record["skillSignal"] = has_skill_signal(record)
    records.sort(key=lambda r: r["trendScore"], reverse=True)

    counts: dict[str, int] = {}
    for record in records:
        counts[record["category"]] = counts.get(record["category"], 0) + 1

    verified = [r for r in records if r["verified"]]
    skill_like = [r for r in records if r.get("skillSignal")]
    by_source: dict[str, int] = {}
    for record in verified:
        key = record.get("verifiedSource") or "unknown"
        by_source[key] = by_source.get(key, 0) + 1
    payload = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "source": "GitHub Search API + Git Tree API + jsDelivr file index",
            "authenticated": bool(TOKEN),
            "queries": len(SEARCH_QUERIES),
            "reposKept": len(records),
            "reposFilteredOut": before - len(records),
            "verifiedRepos": len(verified),
            "verifiedBySource": by_source,
            "skillSignalRepos": len(skill_like),
            "skillsCounted": sum((r["skillCount"] or 0) for r in records),
            "minStars": min_stars,
            "categoryCounts": counts,
        },
        "skills": records,
    }
    (DATA_DIR / "skills.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA_DIR / "meta.json").write_text(json.dumps(payload["meta"], ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA_DIR / "skills.js").write_text(
        "window.SKILL_DATA=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    log(f"emitted {len(records)} repositories, {len(verified)} verified, "
        f"{payload['meta']['skillsCounted']} SKILL.md files")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", nargs="?", default="all",
                        choices=["search", "verify", "scan", "emit", "all"])
    parser.add_argument("--pages", type=int, default=2)
    parser.add_argument("--min-stars", type=int, default=3)
    parser.add_argument("--verify-budget", type=int, default=40)
    parser.add_argument("--workers", type=int, default=10, help="parallel workers for verification and jsDelivr scan")
    parser.add_argument("--recheck", action="store_true", help="ignore cached verification results")
    parser.add_argument("--recheck-below", type=int, default=-1,
                        help="re-verify cached repos whose SKILL.md count is <= N")
    parser.add_argument("--targets", default="", help="comma-separated full_name list to re-verify")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if args.phase in ("search", "all"):
        log("== phase: search ==")
        phase_search(args.pages, args.min_stars)
    if args.phase in ("verify", "all"):
        log("== phase: verify ==")
        phase_verify(args.verify_budget, args.min_stars, args.recheck, args.recheck_below, args.targets, args.workers)
    if args.phase in ("scan", "all"):
        log("== phase: scan (jsDelivr) ==")
        phase_scan(args.workers, args.min_stars)
    if args.phase in ("emit", "all"):
        log("== phase: emit ==")
        phase_emit(args.min_stars)
    return 0


if __name__ == "__main__":
    sys.exit(main())
