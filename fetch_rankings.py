#!/usr/bin/env python3
"""Rankings-driven novelty detector for AI Compass.

Analyses public rankings, compares them with the catalog in index.html and:
  * auto-adds curated candidates (catalog-candidates.json) that are trending
    but missing from the catalog, tagging them with added_at so the UI can
    badge them as new (the badge fades after NEW_WINDOW_DAYS)
  * auto-adds a few strong trends that are not in the catalog yet, but only
    when the vendor country is known (the geo chips need it) and the item
    clears a ranking threshold or shows up in two sources at once; the number
    is capped by AUTO_ADD_MAX and every decision is logged in the feed
  * reports every other trending item that is not in the catalog as a
    "candidate" in rankings-feed.json, for review and manual addition

Sources: OpenRouter (usage), Hugging Face (trendingScore), Artificial Analysis (changelog).
Nothing is invented: unknown URLs fall back to the source page, and no scores
from these sites are copied into the catalog.

Usage:  python3 fetch_rankings.py
Exit code 0 when the feed was written, 1 when nothing could be collected.
"""

import datetime
import html as html_module
import json
import os
import re
import sys
import urllib.request

UA = "AI-Compass-Bot/1.0"
NOW = datetime.datetime.now(datetime.timezone.utc)
TODAY = NOW.date().isoformat()

CATALOG_FILE = "index.html"
CANDIDATES_FILE = "catalog-candidates.json"
FEED_FILE = "rankings-feed.json"

MAX_CANDIDATES = 12

# --- automatic addition of trending items -----------------------------------
# Deliberately conservative: a catalog that quietly fills up with junk is worse
# than a catalog that grows slowly. Override with env vars when needed.
AUTO_ADD_MAX = int(os.environ.get("AUTO_ADD_MAX", "2"))
AUTO_ADD_MIN_HF_DOWNLOADS = int(os.environ.get("AUTO_ADD_MIN_HF_DOWNLOADS", "20000"))
AUTO_ADD_MAX_OPENROUTER_RANK = int(os.environ.get("AUTO_ADD_MAX_OPENROUTER_RANK", "5"))
DRY_RUN = "--dry-run" in sys.argv

# Hugging Face org -> country. An item whose vendor country is unknown is never
# added automatically: "developer_country: unknown" would break the geo chips.
ORG_COUNTRY = {
    "openai": "US", "anthropic": "US", "google": "US", "deepmind": "US",
    "meta": "US", "meta-llama": "US", "microsoft": "US", "nvidia": "US",
    "xai": "US", "eleutherai": "US", "allenai": "US", "runwayml": "US",
    "huggingface": "US", "huggingfaceh4": "US", "cohere": "CA", "coherelabs": "CA",
    "stabilityai": "GB", "mistralai": "FR", "lightricks": "IL", "tii": "AE", "tiiuae": "AE",
    "alibaba": "CN", "qwen": "CN", "deepseek-ai": "CN", "deepseek": "CN",
    "moonshotai": "CN", "moonshot": "CN", "baidu": "CN", "tencent": "CN",
    "zhipuai": "CN", "thudm": "CN", "minimax": "CN", "xiaomi": "CN",
    "stepfun-ai": "CN", "kuaishou": "CN", "sensetime": "CN", "01-ai": "CN",
    "internlm": "CN", "openbmb": "CN", "bytedance": "CN", "bytedance-research": "CN",
    "yandex": "RU", "sber": "RU", "ai-sage": "RU",
}

# nicer display names than "deepseek ai" -> "DeepSeek AI"
ORG_DEVELOPER = {
    "deepseek-ai": "DeepSeek", "meta-llama": "Meta", "mistralai": "Mistral AI",
    "stabilityai": "Stability AI", "eleutherai": "EleutherAI",
    "allenai": "Allen Institute for AI", "runwayml": "Runway", "xai": "xAI",
    "tiiuae": "TII", "01-ai": "01.AI", "zhipuai": "Zhipu AI", "stepfun-ai": "StepFun",
    "sensetime": "SenseTime", "thudm": "Tsinghua", "openbmb": "OpenBMB",
    "bytedance-research": "ByteDance", "huggingfaceh4": "Hugging Face", "ai-sage": "AI-Sage",
}

# pipeline_tag -> (type, category, images, has_video, has_audio)
HF_PIPELINE_TYPES = {
    "text-generation": ("model", "open", False, False, False),
    "image-text-to-text": ("model", "open", False, False, False),
    "any-to-any": ("model", "open", False, False, False),
    "text-to-image": ("tool", "image", True, False, False),
    "image-to-video": ("tool", "video", False, True, False),
    "text-to-video": ("tool", "video", False, True, False),
    "text-to-speech": ("tool", "audio", False, False, True),
}

# provider (as written on the leaderboards) -> catalog entry it belongs to
PROVIDER_ALIASES = {
    "openai": "ChatGPT", "anthropic": "Claude", "google": "Gemini", "deepmind": "Gemini",
    "deepseek": "DeepSeek", "alibaba": "Qwen (Alibaba)", "qwen": "Qwen (Alibaba)",
    "moonshotai": "Kimi (Moonshot AI)", "moonshot": "Kimi (Moonshot AI)", "kimi": "Kimi (Moonshot AI)",
    "minimax": "MiniMax (Hailuo AI)", "zai": "Zhipu AI (GLM)", "zhipu": "Zhipu AI (GLM)",
    "tencent": "Tencent Hunyuan (Yuanbao)", "hunyuan": "Tencent Hunyuan (Yuanbao)",
    "stepfun": "StepFun (Step 5)", "xiaomi": "Xiaomi MiMo", "baidu": "Baidu ERNIE",
    "meta": "Meta Llama", "nvidia": "NVIDIA Nemotron", "reflection": "Reflection AI",
    "mistral": "Mistral Vibe (Le Chat)", "xai": "Grok (xAI)", "perplexity": "Perplexity",
    "sber": "GigaChat", "yandex": "Алиса AI (Яндекс)",
}

SOURCE_URLS = {
    "OpenRouter": "https://openrouter.ai/rankings",
    "Hugging Face": "https://huggingface.co/models?sort=trending",
    "Artificial Analysis": "https://artificialanalysis.ai/",
}

# model-family prefixes -> catalog entry they belong to (for items without an author)
NAME_HINTS = [
    "gpt", "o1", "o3", "o4", "astra", "claude", "gemini", "gemma", "glm", "qwen",
    "deepseek", "kimi", "llama", "mistral", "grok", "ernie", "hunyuan", "mimo",
    "step", "nemotron", "kandinsky", "gigachat", "gigacode", "alice",
]

# Hugging Face pipeline tags worth surfacing as catalog candidates
HF_TAGS = {
    "text-generation", "image-text-to-text", "any-to-any", "text-to-image",
    "image-to-video", "text-to-video", "text-to-speech",
}

# names that are fine-tunes / repackagings rather than new products
HF_NOISE = re.compile(r"(?i)uncensored|quant|gguf|nvfp4|fp4|fp8|awq|gptq|int4|adapted|heretic|lora|merge|finetun|abliterated|nsfw|test|demo")


def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def norm(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def base_name(name):
    """Drop trailing effort/quant variants, e.g. 'GPT-6.2 Astra (Max)' -> 'GPT-6.2 Astra'."""
    return re.sub(r"\s*\([^)]*\)\s*$", "", name or "").strip()


def slugify(name):
    """A URL-safe id from a display name: 'DeepSeek-V3' -> 'deepseek-v3'.

    Auto-added rows need an id too, otherwise service.html?id=<slug> cannot reach
    them and the detail page has nothing to join on.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "model"


def strip_tags(raw):
    text = re.sub(r"<script.*?</script>", " ", raw, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text)


# ------------------------------------------------------------------ sources
def fetch_openrouter_top(limit=15):
    try:
        text = strip_tags(http_get("https://openrouter.ai/rankings").decode("utf-8", "replace"))
    except Exception as exc:
        print(f"  ! OpenRouter: {exc}")
        return []
    start = text.find("Rank Model Author tokens processed")
    if start < 0:
        return []
    block = text[start:start + 4000]
    out, seen = [], set()
    pattern = re.compile(r"(\d{1,2})\s+(.+?)\s+([a-z0-9.\-]{2,20})\s+([\d.]+[TBM])\s+tokens\s+([+\-]?\d+%|new)")
    for match in pattern.finditer(block):
        rank = int(match.group(1))
        if rank in seen:
            continue
        seen.add(rank)
        out.append({
            "name": re.sub(r"\s+\d+$", "", match.group(2)).strip(),
            "author": match.group(3),
            "source": "OpenRouter",
            "rank": rank,
        })
        if len(out) >= limit:
            break
    return out


def fetch_hf_trending(limit=30):
    url = f"https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit={limit}"
    try:
        data = json.loads(http_get(url))
    except Exception as exc:
        print(f"  ! Hugging Face: {exc}")
        return []
    out = []
    for model in data:
        mid = model.get("modelId") or model.get("id") or ""
        if not mid:
            continue
        out.append({
            "name": mid.split("/")[-1],
            "author": mid.split("/")[0] if "/" in mid else "",
            "url": "https://huggingface.co/" + mid,
            "source": "Hugging Face",
            "score": model.get("trendingScore"),
            "downloads": model.get("downloads"),
            "likes": model.get("likes"),
            "tag": model.get("pipeline_tag"),
        })
    return out


def fetch_aa_new(limit=12):
    try:
        text = strip_tags(http_get("https://artificialanalysis.ai/").decode("utf-8", "replace"))
    except Exception as exc:
        print(f"  ! Artificial Analysis: {exc}")
        return []
    out = []
    pattern = re.compile(r"New language model evaluation\s*·\s*\d{1,2}\s+\w+\s+(.+?)(?=\s+New\b|\s+See\b|\s+Intelligence\b|$)")
    for match in pattern.finditer(text):
        name = html_module.unescape(match.group(1)).strip()
        if name:
            out.append({"name": name, "author": "", "source": "Artificial Analysis"})
        if len(out) >= limit:
            break
    return out


# ------------------------------------------------------------------ catalog
def load_catalog(html):
    start = html.find("const services = [")
    end = html.find("\n        ];", start)
    block = html[start:end] if start >= 0 and end >= 0 else html
    names = re.findall(r'name:\s*"([^"]+)"', block)
    devs = re.findall(r'developer:\s*"([^"]+)"', block)
    ids = re.findall(r'id:\s*"([^"]+)"', block)
    return names, devs, ids


def in_catalog(item, cat_names, cat_devs):
    author = norm(item.get("author"))
    if author:
        for alias in PROVIDER_ALIASES:
            if alias in author:
                return True
    name = norm(item.get("name"))
    if any(name.startswith(hint) for hint in NAME_HINTS):
        return True
    if len(name) >= 5:
        for cn in cat_names:
            candidate = norm(cn)
            if candidate and (candidate == name or candidate in name or name in candidate):
                return True
    return False


def candidate_matches_item(candidate, item):
    dn = norm(item.get("name"))
    if not dn:
        return False
    aliases = [norm(a) for a in candidate.get("aliases", [])] + [norm(candidate.get("name"))]
    return any(alias and (alias in dn or dn in alias) for alias in aliases)


# ------------------------------------------------- automatic trend addition
def trend_eligible(item):
    """Does one ranking row clear the bar on its own?"""
    if item.get("source") == "OpenRouter":
        return (item.get("rank") or 99) <= AUTO_ADD_MAX_OPENROUTER_RANK
    if item.get("source") == "Hugging Face":
        return (item.get("downloads") or 0) >= AUTO_ADD_MIN_HF_DOWNLOADS
    return False


def trend_sort_key(item):
    """OpenRouter by rank, then Hugging Face by downloads, then the rest."""
    if item.get("source") == "OpenRouter":
        return (0, item.get("rank") or 99)
    if item.get("source") == "Hugging Face":
        return (1, -(item.get("downloads") or 0))
    return (2, 0)


def trend_description(item):
    """Bilingual, template-only wording: no invented scores, no invented claims."""
    source = item.get("source") or "the public rankings"
    facts_en, facts_ru = [], []
    if item.get("rank"):
        facts_en.append(f"#{item['rank']} in the {source} usage ranking")
        facts_ru.append(f"№{item['rank']} в рейтинге использования {source}")
    if item.get("downloads"):
        facts_en.append(f"{int(item['downloads']):,} downloads on Hugging Face")
        facts_ru.append(f"{int(item['downloads']):,} скачиваний на Hugging Face")
    head_en = "Open model spotted in the public rankings" + (f" ({', '.join(facts_en)})" if facts_en else "")
    head_ru = "Открытая модель, замеченная в публичных рейтингах" + (f" ({', '.join(facts_ru)})" if facts_ru else "")
    en = (head_en + ". Added automatically from the rankings feed: check the licence, the weights and the "
          "limits on the model page before relying on it.")
    ru = (head_ru + ". Добавлена автоматически из ленты рейтингов: проверьте лицензию, веса и лимиты "
          "на странице модели, прежде чем полагаться на неё.")
    return en, ru


def infer_entry(item):
    """Build a catalog row from a trending item, or None when we are not sure."""
    author = (item.get("author") or "").strip().lower()
    country = ORG_COUNTRY.get(author)
    if not country:
        return None
    name = base_name(item.get("name") or "")
    if not name or len(name) < 3 or len(name) > 40 or HF_NOISE.search(name):
        return None
    if item.get("source") == "Hugging Face":
        shape = HF_PIPELINE_TYPES.get(item.get("tag"))
        if not shape:
            return None
        stype, category, images, has_video, has_audio = shape
        url = item.get("url") or ""
    else:
        stype, category, images, has_video, has_audio = "model", "open", False, False, False
        url = item.get("url") or SOURCE_URLS.get(item.get("source"), "")
    if not url.startswith("https://"):
        return None
    desc_en, desc_ru = trend_description(item)
    return {
        "id": slugify(name),
        "name": name,
        "type": stype,
        "category": category,
        "access_level": "limited",
        # The badge has to say what the catch is, so an auto-detected row states
        # its own caveat instead of falling back to a generic "limited access".
        "access_note_ru": "Новая модель из ленты: проверьте лицензию и лимиты",
        "access_note_en": "New from the feed: check the licence and limits",
        "desc_en": desc_en,
        "desc_ru": desc_ru,
        "vpn": False,
        "images": images,
        "code": False,
        "search": False,
        "agents": False,
        "servers": country,
        "payment": "BYN" if country == "BY" else ("RU" if country == "RU" else "FOREIGN"),
        "free": True,
        "url": url,
        "developer": ORG_DEVELOPER.get(author) or author.replace("-", " ").title(),
        "developer_country": country,
        "has_video": has_video,
        "has_audio": has_audio,
    }


# ------------------------------------------------------------- auto-add line
LINE_KEYS = ["id", "name", "type", "category", "access_level", "access_note_ru", "access_note_en",
             "desc_en", "desc_ru", "vpn", "images",
             "code", "search", "agents", "servers", "payment", "free", "url", "developer", "developer_country"]
AUTO_MARKER = "            // --- AUTO-ADDED from the rankings feed ---"


def service_line(entry, added_at):
    # Skip absent keys: an auto-added row must not carry "access_note_ru: null".
    parts = [f"{key}: {json.dumps(entry.get(key), ensure_ascii=False)}"
             for key in LINE_KEYS if entry.get(key) is not None]
    parts.append("aa_score_unverified: null")
    parts.append("arena_elo_unverified: null")
    parts.append(f"has_video: {json.dumps(bool(entry.get('has_video')))}")
    parts.append(f"has_audio: {json.dumps(bool(entry.get('has_audio')))}")
    parts.append(f"added_at: {json.dumps(added_at)}")
    return "            { " + ", ".join(parts) + " },"


def insert_services(html, lines):
    if not lines:
        return html
    block = "".join("\n" + line for line in lines)
    if AUTO_MARKER in html:
        at = html.index(AUTO_MARKER) + len(AUTO_MARKER)
        return html[:at] + block + html[at:]
    end = html.find("\n        ];", html.find("const services = ["))
    return html[:end] + "\n" + AUTO_MARKER + block + html[end:]


# ---------------------------------------------------------------------- main
def main():
    print("AI Compass - rankings novelty detector")
    detected = []
    print("Sources:")
    or_top = fetch_openrouter_top()
    print(f"  OpenRouter: {len(or_top)}")
    detected.extend(or_top)
    hf = fetch_hf_trending()
    print(f"  Hugging Face: {len(hf)}")
    detected.extend(hf)
    aa = fetch_aa_new()
    print(f"  Artificial Analysis: {len(aa)}")
    detected.extend(aa)

    if not detected:
        print("! no rankings collected - nothing to do")
        return 1

    with open(CATALOG_FILE, encoding="utf-8") as handle:
        html = handle.read()
    cat_names, cat_devs, cat_ids = load_catalog(html)

    with open(CANDIDATES_FILE, encoding="utf-8") as handle:
        candidates = json.load(handle).get("candidates", [])

    # 1. curated candidates that are trending and still missing -> auto-add
    added, added_names, kb_names = [], set(), set()
    for candidate in candidates:
        for item in detected:
            if not candidate_matches_item(candidate, item):
                continue
            kb_names.add(norm(base_name(item["name"])))
            if candidate["name"] not in cat_names and candidate["name"] not in added_names:
                added.append(candidate)
                added_names.add(candidate["name"])

    # 2. strong trends with a known vendor country -> auto-add (conservative)
    auto_details, auto_skipped = [], []
    if AUTO_ADD_MAX > 0:
        per_name = {}
        for item in detected:
            key = norm(base_name(item["name"]))
            if key:
                per_name.setdefault(key, set()).add(item["source"])
        names_now = set(cat_names) | set(added_names)
        used_ids = set(cat_ids)
        seen_auto = set()
        for item in sorted(detected, key=trend_sort_key):
            if len(auto_details) >= AUTO_ADD_MAX:
                break
            display = base_name(item["name"])
            key = norm(display)
            if not key or key in seen_auto or key in kb_names:
                continue
            multi_source = len(per_name.get(key, ())) >= 2
            if not (trend_eligible(item) or multi_source):
                continue
            if display in names_now or in_catalog(dict(item, name=display), cat_names, cat_devs):
                continue
            entry = infer_entry(item)
            if entry is None:
                auto_skipped.append({"name": display, "source": item["source"],
                                     "reason": "unknown vendor country or model type"})
                continue
            if entry["name"] in names_now:
                continue
            # An id must stay unique: service.html?id=<slug> has to reach one row.
            if entry.get("id") in used_ids:
                auto_skipped.append({"name": display, "source": item["source"],
                                     "reason": "id already taken"})
                continue
            seen_auto.add(key)
            added.append(entry)
            added_names.add(entry["name"])
            names_now.add(entry["name"])
            used_ids.add(entry.get("id"))
            auto_details.append({
                "name": entry["name"],
                "source": item["source"],
                "rank": item.get("rank"),
                "downloads": item.get("downloads"),
                "url": entry["url"],
                "reason": "multi-source" if multi_source else "ranking-threshold",
            })

    if added:
        if DRY_RUN:
            print("  dry run - would add: " + ", ".join(e["name"] for e in added))
        else:
            html = insert_services(html, [service_line(entry, TODAY) for entry in added])
            with open(CATALOG_FILE, "w", encoding="utf-8") as handle:
                handle.write(html)
            print("  auto-added to catalog: " + ", ".join(e["name"] for e in added))

    # 3. everything trending that is not in the catalog -> review list
    known = set(cat_names) | {e["name"] for e in added}
    buckets = {"OpenRouter": [], "Artificial Analysis": [], "Hugging Face": []}
    seen = set()
    for item in detected:
        if item["source"] == "Hugging Face":
            if item.get("tag") not in HF_TAGS or len(item["name"]) > 40 or HF_NOISE.search(item["name"]):
                continue
        display = base_name(item["name"])
        key = norm(display)
        if not key or key in seen or key in kb_names:
            continue
        probe = dict(item, name=display)
        if display in known or in_catalog(probe, cat_names, cat_devs):
            continue
        seen.add(key)
        buckets.get(item["source"], []).append(probe)

    ordered = sorted(buckets["OpenRouter"], key=lambda i: i.get("rank") or 99)[:6]
    ordered += buckets["Artificial Analysis"][:4]
    ordered += sorted(buckets["Hugging Face"], key=lambda i: -(i.get("score") or 0))
    review = []
    for item in ordered[:MAX_CANDIDATES]:
        review.append({
            "name": item["name"],
            "author": item.get("author", ""),
            "source": item["source"],
            "url": item.get("url") or SOURCE_URLS.get(item["source"], ""),
            "rank": item.get("rank"),
        })

    feed = {
        "last_updated": NOW.strftime("%Y-%m-%d %H:%M"),
        "top": [{"name": i["name"], "author": i.get("author", ""), "source": i["source"],
                 "in_catalog": in_catalog(i, cat_names, cat_devs)} for i in detected],
        "auto_added": [e["name"] for e in added],
        # why each service appeared in the catalog, so the decision is auditable
        "auto_added_details": auto_details,
        # strong trends we refused to add and why (the review list for a human)
        "auto_add_skipped": auto_skipped[:10],
        "candidates": review,
    }
    if DRY_RUN:
        print("  dry run - rankings-feed.json not written")
    else:
        with open(FEED_FILE, "w", encoding="utf-8") as handle:
            json.dump(feed, handle, ensure_ascii=False, indent=2)

    print(f"OK  detected={len(detected)}  auto_added={len(added)}  candidates={len(review)}")
    if auto_details:
        for row in auto_details:
            print(f"  + {row['name']} ({row['source']}, {row['reason']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())