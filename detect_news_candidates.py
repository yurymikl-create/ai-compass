#!/usr/bin/env python3
"""News-driven launch detector for AI Compass.

Reads news.json (the daily AI news feed) and flags headlines that look like a
product or model launch from a known vendor whose product is not in the catalog
yet. Writes news-candidates.json for a human to review.

Why this exists: the rankings pipeline (fetch_rankings.py) only sees open models
and API rankings. Closed consumer products from the giants (Microsoft Copilot,
Meta AI, Canva, ...) never appear there, so a big launch could slip through. The
news feed already carries those announcements, so this script turns them into a
review list.

Nothing is added to the catalog automatically: the catalog is curated, so the
final decision stays with a human. The script only makes sure nothing is missed.

Usage: python3 detect_news_candidates.py [--dry-run]
Exit code 0 when the review file was written, 1 when news.json is missing/empty.
"""

import datetime
import json
import re
import sys

NEWS_FILE = "news.json"
CATALOG_FILE = "index.html"
OUTPUT_FILE = "news-candidates.json"

MAX_CANDIDATES = 40
MAX_AGE_DAYS = 30

# A source that is a single vendor's own blog: every post is that vendor's.
SOURCE_VENDORS = {
    "OpenAI": "OpenAI",
    "Google AI": "Google",
    "Google DeepMind": "Google DeepMind",
}

# Vendor aliases found in a headline -> canonical vendor name.
# Keep this list explicit: guessing vendors from free text is how noise starts.
VENDOR_ALIASES = {
    "microsoft": "Microsoft",
    "google": "Google",
    "deepmind": "Google DeepMind",
    "gemini": "Google",
    "meta": "Meta",
    "llama": "Meta",
    "openai": "OpenAI",
    "chatgpt": "OpenAI",
    "anthropic": "Anthropic",
    "claude": "Anthropic",
    "amazon": "Amazon",
    "aws": "Amazon",
    "apple": "Apple",
    "nvidia": "NVIDIA",
    "adobe": "Adobe",
    "canva": "Canva",
    "notion": "Notion",
    "grammarly": "Grammarly",
    "stability": "Stability AI",
    "midjourney": "Midjourney",
    "runway": "Runway",
    "elevenlabs": "ElevenLabs",
    "mistral": "Mistral AI",
    "cohere": "Cohere",
    "perplexity": "Perplexity",
    "xai": "xAI",
    "grok": "xAI",
    "alibaba": "Alibaba",
    "qwen": "Alibaba",
    "baidu": "Baidu",
    "tencent": "Tencent",
    "bytedance": "ByteDance",
    "samsung": "Samsung",
    "ibm": "IBM",
    "salesforce": "Salesforce",
    "figma": "Figma",
    "atlassian": "Atlassian",
    "zoom": "Zoom",
    "synthesia": "Synthesia",
    "heygen": "HeyGen",
    "descript": "Descript",
    "capcut": "CapCut",
    "freepik": "Freepik",
    "hume": "Hume AI",
    "elicit": "Elicit",
    "consensus": "Consensus",
}

# Headline wording that signals a launch or a public announcement.
# Deliberately narrow: "new" or "update" alone would flag every blog post.
LAUNCH_RE = re.compile(
    r"\b(?:launch|release|announce|introduce|unveil|debut|ship)\w*\b"
    r"|\b(?:now available|general availability|rolls? out|rolling out)\b"
    r"|представил|запустил|выпустил|анонсировал|доступн",
    re.IGNORECASE,
)

# Catalog tokens too generic to prove "this product is already listed".
GENERIC_TOKENS = {
    "developer", "studio", "magic", "assistant", "platform", "suite", "cloud",
    "models", "model", "tools", "tool", "chat", "search", "code", "video",
    "image", "audio", "data", "open", "smart", "plus", "pro", "max", "mini",
}


def norm(text):
    """Lower-case and keep only letters/digits so 'GPT-6' matches 'gpt6'."""
    return re.sub(r"[^0-9a-zа-яё]", "", (text or "").lower())


def load_catalog_names():
    try:
        with open(CATALOG_FILE, encoding="utf-8") as handle:
            html = handle.read()
    except OSError:
        return []
    start = html.find("const services = [")
    end = html.find("\n        ];", start)
    block = html[start:end] if start >= 0 and end > start else html
    return re.findall(r'name:\s*"([^"]+)"', block)


def catalog_tokens(names):
    """Distinctive tokens from catalog product names (vendor words removed)."""
    vendor_words = set(VENDOR_ALIASES.keys())
    tokens = set()
    for name in names:
        cleaned = re.sub(r"\([^)]*\)", " ", name)  # drop parenthetical aliases
        for word in re.findall(r"[0-9A-Za-zА-Яа-яЁё]+", cleaned):
            key = norm(word)
            if len(key) >= 5 and key not in vendor_words and key not in GENERIC_TOKENS:
                tokens.add(key)
    return tokens


def find_vendor(title, source):
    """Return the vendor for a headline, or None when it cannot be pinned down."""
    low = title.lower()
    for alias, vendor in VENDOR_ALIASES.items():
        if re.search(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", low):
            return vendor
    return SOURCE_VENDORS.get(source)


def already_in_catalog(title, tokens):
    """True when the headline already names a product from the catalog."""
    low = norm(title)
    return any(token in low for token in tokens)


def load_previous():
    try:
        with open(OUTPUT_FILE, encoding="utf-8") as handle:
            return json.load(handle).get("candidates") or []
    except (OSError, ValueError):
        return []


def main():
    dry_run = "--dry-run" in sys.argv
    print("AI Compass - news launch detector")

    try:
        with open(NEWS_FILE, encoding="utf-8") as handle:
            news = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"! cannot read {NEWS_FILE}: {exc}")
        return 1

    items = news.get("news") or []
    if not items:
        print("! news feed is empty - nothing to scan")
        return 1

    names = load_catalog_names()
    tokens = catalog_tokens(names)
    print(f"catalog: {len(names)} services, {len(tokens)} distinctive tokens")

    cutoff = (datetime.date.today() - datetime.timedelta(days=MAX_AGE_DAYS)).isoformat()
    flagged = []
    seen = set()

    for item in items:
        title = (item.get("title") or "").strip()
        url = item.get("url") or ""
        if not title or not url:
            continue
        if not LAUNCH_RE.search(title):
            continue
        vendor = find_vendor(title, item.get("source") or "")
        if not vendor:
            continue
        if already_in_catalog(title, tokens):
            continue
        key = norm(title)
        if key in seen:
            continue
        seen.add(key)
        flagged.append({
            "vendor": vendor,
            "headline": title,
            "url": url,
            "source": item.get("source") or "",
            "date": item.get("date") or "",
            "reason": "launch wording in a vendor headline",
        })

    # Merge with the previous review list: newest first, dedupe by URL, drop stale.
    merged = []
    seen_urls = set()
    for row in flagged + load_previous():
        url = row.get("url") or ""
        if not url or url in seen_urls:
            continue
        date = str(row.get("date") or "")
        if date and date < cutoff:
            continue
        seen_urls.add(url)
        merged.append(row)
    merged = merged[:MAX_CANDIDATES]

    result = {
        "last_updated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "note": "Human review only: nothing here is added to the catalog automatically.",
        "candidates": merged,
    }

    print(f"flagged {len(flagged)} new launch headline(s); review list now {len(merged)}")
    for row in flagged[:10]:
        print(f"  + {row['vendor']}: {row['headline'][:70]}")

    if dry_run:
        print(f"dry run - not writing {OUTPUT_FILE}")
        return 0

    with open(OUTPUT_FILE, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"OK wrote {OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
