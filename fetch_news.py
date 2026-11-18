#!/usr/bin/env python3
"""Daily news collector for AI Compass.

Writes news.json with two independent feeds:

  news[]        - new AI models, tools and platforms (global, for the catalog)
  regulation[]  - AI & personal-data regulation news in Belarus

Each feed keeps a short rolling history (deduplicated by URL, last 30 days),
so a temporary outage of one source never wipes previously collected items.
Every source is fetched on its own; one failure never blocks the others.

Usage:  python3 fetch_news.py
Exit code 0 when news.json was written, 1 when nothing could be collected.
"""

import datetime
import html
import json
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

UA = "AI-Compass-Bot/1.0"
NOW = datetime.datetime.now(datetime.timezone.utc)
TODAY = NOW.date()

# --------------------------------------------------------------- AI filter
AI_KEYWORDS = [
    "ai", "artificial intelligence", "llm", "gpt", "claude", "deepseek",
    "openai", "anthropic", "gemini", "neural", "machine learning",
    "model", "models", "chatbot", "inference", "transformer", "rag", "agentic",
]
# Word boundaries are essential: a plain substring match for "ai" also hits
# "email", "airline" and "straight", which polluted news.json before.
AI_RE = re.compile(r"(?<![a-z0-9])(?:%s)(?![a-z0-9])" % "|".join(re.escape(k) for k in AI_KEYWORDS))
MIN_SCORE = 40

# ---------------------------------------------- Belarus / regulation filter
# AI terms (Russian) plus personal-data / data-protection terms. Generic legal
# words ("законодательство", "реестр", "цифров") are intentionally excluded -
# they match boilerplate navigation on pravo.by instead of real AI stories.
AI_RU_STEM_RE = re.compile("|".join(["искусственн", "нейросет", "машинн", "робот"]), re.IGNORECASE)
AI_RU_WORD_RE = re.compile(r"(?<![а-яёa-z])ии(?![а-яёa-z])", re.IGNORECASE)
DATA_RU_RE = re.compile("|".join(["персональн", "нцзпд"]), re.IGNORECASE)


def is_regulation(title):
    """True for AI stories and for personal-data / data-protection stories."""
    title = title or ""
    return bool(AI_RU_STEM_RE.search(title) or AI_RU_WORD_RE.search(title) or DATA_RU_RE.search(title))


# ----------------------------------------------------------------- sources
# every post on these feeds is AI by definition -> no keyword filter needed
GLOBAL_FEEDS = [
    ("https://huggingface.co/blog/feed.xml", "Hugging Face"),
    ("https://openai.com/news/rss.xml", "OpenAI"),
    ("https://blog.google/technology/ai/rss/", "Google AI"),
    ("https://deepmind.google/blog/rss.xml", "Google DeepMind"),
]
# Belarus legal / AI news (mixed feed -> filtered by keywords)
BELARUS_FEEDS = [
    ("https://www.belta.by/rss", "БелТА"),
]
PRAVO_URL = "https://pravo.by/novosti/"

MAX_GLOBAL = 12
MAX_REGULATION = 10
MAX_AGE_DAYS = 30

# model / tool / platform classification (word-boundary aware)
PLATFORM_RE = re.compile(r"(?<![a-z])(?:platform|api|studio|cloud|aggregator|marketplace|subscription)(?![a-z])")
TOOL_RE = re.compile(r"(?<![a-z])(?:editor|plugin|extension|copilot|cursor|ide|tool|desktop|app)(?![a-z])")


# ----------------------------------------------------------------- helpers
def http_get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def _localname(tag):
    return tag.rsplit("}", 1)[-1]


def _clean(text):
    return html.unescape(re.sub(r"\s+", " ", text or "")).strip()


def _iso_date(value):
    """Parse RFC-822 (pubDate) or ISO-8601 dates; never return a future day."""
    day = TODAY
    if value:
        value = value.strip()
        try:
            from email.utils import parsedate_to_datetime
            parsed = parsedate_to_datetime(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=datetime.timezone.utc)
            day = parsed.astimezone(datetime.timezone.utc).date()
        except Exception:
            match = re.match(r"(\d{4})-(\d{2})-(\d{2})", value)
            if match:
                day = datetime.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    return (day if day <= TODAY else TODAY).isoformat()


def parse_feed(raw):
    """Return {title,url,date} dicts from an RSS 2.0 or Atom document."""
    items = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return items
    for node in root.iter():
        if _localname(node.tag) not in ("item", "entry"):
            continue
        title = link = date = None
        for child in node:
            name = _localname(child.tag)
            if name == "title" and title is None:
                title = _clean(child.text)
            elif name == "link":
                href = child.get("href") or _clean(child.text)
                if href and (link is None or child.get("rel", "alternate") == "alternate"):
                    link = href
            elif name in ("pubDate", "published", "updated") and date is None:
                date = child.text
        if title and link:
            items.append({"title": title, "url": link, "date": _iso_date(date)})
    return items


def fetch_feed(url, source, keep=None, limit=20):
    try:
        feed = parse_feed(http_get(url))
    except Exception as exc:
        print(f"  ! {source}: {exc}")
        return []
    items = []
    for item in feed:
        if keep and not keep(item["title"]):
            continue
        item["source"] = source
        items.append(item)
        if len(items) >= limit:
            break
    return items


def classify(title):
    low = (title or "").lower()
    if PLATFORM_RE.search(low):
        return "platform"
    if TOOL_RE.search(low):
        return "tool"
    return "model"


def fetch_hackernews(limit=12):
    items = []
    try:
        ids = json.loads(http_get("https://hacker-news.firebaseio.com/v0/topstories.json"))[:120]
    except Exception as exc:
        print(f"  ! Hacker News: {exc}")
        return items
    for story_id in ids:
        try:
            item = json.loads(http_get(f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json", timeout=8))
        except Exception:
            continue
        if not item or "title" not in item:
            continue
        if not AI_RE.search(item["title"].lower()) or item.get("score", 0) < MIN_SCORE:
            continue
        day = datetime.datetime.fromtimestamp(item.get("time", 0), datetime.timezone.utc).date()
        items.append({
            "title": _clean(item["title"]),
            "url": item.get("url") or f"https://news.ycombinator.com/item?id={story_id}",
            "source": "Hacker News",
            "date": (day if day <= TODAY else TODAY).isoformat(),
            "score": item.get("score", 0),
            "category": classify(item["title"]),
        })
        if len(items) >= limit:
            break
    return items


def fetch_pravo(limit=10):
    """Scrape the legal-news list on pravo.by for AI / data-protection items."""
    items = []
    try:
        page = http_get(PRAVO_URL).decode("utf-8", "replace")
    except Exception as exc:
        print(f"  ! pravo.by: {exc}")
        return items
    seen = set()
    for match in re.finditer(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', page, re.S | re.I):
        href = match.group(1).strip()
        title = _clean(re.sub(r"<[^>]+>", " ", match.group(2)))
        if len(title) < 18 or not is_regulation(title):
            continue
        if href.startswith("/"):
            href = "https://pravo.by" + href
        if not href.startswith("http") or href in seen:
            continue
        seen.add(href)
        items.append({"title": title, "url": href, "source": "pravo.by", "date": TODAY.isoformat()})
        if len(items) >= limit:
            break
    return items


def load_previous():
    try:
        with open("news.json", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def _fresh_enough(item):
    try:
        return (TODAY - datetime.date.fromisoformat(item["date"])).days <= MAX_AGE_DAYS
    except Exception:
        return True


def merge(previous, fresh, cap):
    """New items first, then history; dedupe by URL and drop stale/incomplete rows."""
    seen = set()
    merged = []
    for item in list(fresh) + list(previous):
        url = item.get("url")
        if not url or url in seen or not _fresh_enough(item):
            continue
        if not all(item.get(key) for key in ("title", "url", "source", "date")):
            continue
        seen.add(url)
        merged.append(item)
    merged.sort(key=lambda row: row.get("date", ""), reverse=True)
    return merged[:cap]


def main():
    print("AI Compass - daily news collector")

    print("Global AI news:")
    global_news = []
    for url, source in GLOBAL_FEEDS:
        got = fetch_feed(url, source)
        print(f"  {source}: {len(got)}")
        global_news.extend(got)
    hn = fetch_hackernews()
    print(f"  Hacker News: {len(hn)}")
    global_news.extend(hn)
    for item in global_news:
        item.setdefault("category", classify(item["title"]))

    print("Belarus AI / regulation news:")
    regulation = []
    for url, source in BELARUS_FEEDS:
        got = fetch_feed(url, source, keep=is_regulation, limit=10)
        print(f"  {source}: {len(got)}")
        regulation.extend(got)
    pravo = fetch_pravo()
    print(f"  pravo.by: {len(pravo)}")
    regulation.extend(pravo)

    previous = load_previous()
    news = merge(previous.get("news", []), global_news, MAX_GLOBAL)
    reg = merge(previous.get("regulation", []), regulation, MAX_REGULATION)

    if not news and not reg:
        print("! nothing collected and no history to keep - news.json left untouched")
        return 1

    result = {
        "last_updated": NOW.strftime("%Y-%m-%d %H:%M"),
        "news": news,
        "regulation": reg,
    }
    with open("news.json", "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print(f"OK  news={len(news)}  regulation={len(reg)}  at {result['last_updated']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())