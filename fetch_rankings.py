#!/usr/bin/env python3
"""Rankings-driven novelty detector for AI Compass.

Analyses public rankings, compares them with the catalog in index.html and:
  * auto-adds curated candidates (catalog-candidates.json) that are trending
    but missing from the catalog, tagging them with added_at so the UI can
    badge them as new (the badge fades after NEW_WINDOW_DAYS)
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
import re
import urllib.request

UA = "AI-Compass-Bot/1.0"
NOW = datetime.datetime.now(datetime.timezone.utc)
TODAY = NOW.date().isoformat()

CATALOG_FILE = "index.html"
CANDIDATES_FILE = "catalog-candidates.json"
FEED_FILE = "rankings-feed.json"

MAX_CANDIDATES = 12

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
    return names, devs


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


# ------------------------------------------------------------- auto-add line
LINE_KEYS = ["name", "type", "category", "access_level", "desc_en", "desc_ru", "vpn", "images",
             "code", "search", "agents", "servers", "payment", "free", "url", "developer", "developer_country"]
AUTO_MARKER = "            // --- AUTO-ADDED from the rankings feed ---"


def service_line(entry, added_at):
    parts = [f"{key}: {json.dumps(entry.get(key), ensure_ascii=False)}" for key in LINE_KEYS]
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
    cat_names, cat_devs = load_catalog(html)

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
    if added:
        html = insert_services(html, [service_line(entry, TODAY) for entry in added])
        with open(CATALOG_FILE, "w", encoding="utf-8") as handle:
            handle.write(html)
        print("  auto-added to catalog: " + ", ".join(e["name"] for e in added))

    # 2. everything trending that is not in the catalog -> review list
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
        "candidates": review,
    }
    with open(FEED_FILE, "w", encoding="utf-8") as handle:
        json.dump(feed, handle, ensure_ascii=False, indent=2)

    print(f"OK  detected={len(detected)}  auto_added={len(added)}  candidates={len(review)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())