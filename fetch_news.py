import json
import re
import urllib.request
import datetime

AI_KEYWORDS = [
    "ai", "artificial intelligence", "llm", "gpt", "claude", "deepseek",
    "openai", "anthropic", "gemini", "neural", "machine learning",
    "model", "models", "chatbot", "inference", "transformer", "rag", "agentic",
]
# Word boundaries are essential: a plain substring match for "ai" also hits
# "email", "airline" and "straight", which is what polluted news.json before.
KEYWORD_RE = re.compile(r"(?<![a-z0-9])(?:%s)(?![a-z0-9])" % "|".join(re.escape(k) for k in AI_KEYWORDS))
MIN_SCORE = 40
MAX_ITEMS = 8


def is_ai_story(title):
    return bool(KEYWORD_RE.search((title or "").lower()))


def fetch_ai_news():
    
    try:
        url = "https://hacker-news.firebaseio.com/v0/topstories.json"
        req = urllib.request.Request(url, headers={"User-Agent": "AI-Compass-Bot/1.0"})
        with urllib.request.urlopen(req, timeout=10) as response:
            story_ids = json.loads(response.read().decode())[:100]

        news_items = []
        
        for story_id in story_ids:
            item_url = f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json"
            try:
                item_req = urllib.request.Request(item_url, headers={"User-Agent": "AI-Compass-Bot/1.0"})
                with urllib.request.urlopen(item_req, timeout=5) as item_response:
                    item = json.loads(item_response.read().decode())
                    
                    if not item or 'title' not in item:
                        continue
                        
                    if is_ai_story(item['title']) and item.get('score', 0) >= MIN_SCORE:
                        news_items.append({
                            "title": item['title'],
                            "url": item.get('url', f"https://news.ycombinator.com/item?id={story_id}"),
                            "source": "Hacker News",
                            "date": datetime.datetime.fromtimestamp(item.get('time', 0), datetime.timezone.utc).strftime('%Y-%m-%d'),
                            "score": item.get('score', 0)
                        })
                        
                        if len(news_items) >= MAX_ITEMS * 3:
                            break
            except Exception:
                continue
                
        # sort by relevance (HN points) and keep the top MAX_ITEMS
        news_items.sort(key=lambda n: n.get('score', 0), reverse=True)
        news_items = news_items[:MAX_ITEMS]

        if not news_items:
            print("❌ AI-релевантных историй не найдено — news.json не перезаписан")
            raise SystemExit(1)

        result = {
            "last_updated": datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M'),
            "news": news_items
        }
                
        with open('news.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
            
        print(f"✅ Успешно обновлено. Найдено {len(news_items)} новостей. Время: {result['last_updated']}")
        
    except SystemExit:
        raise
    except Exception as e:
        print(f"❌ Ошибка при сборе новостей: {e}")
        raise SystemExit(1)

if __name__ == "__main__":
    fetch_ai_news()
