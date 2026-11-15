import json
import urllib.request
import datetime

def fetch_ai_news():
    ai_keywords = ["ai", "artificial intelligence", "llm", "gpt", "claude", "deepseek", "openai", "anthropic", "gemini", "neural", "machine learning"]
    
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
                        
                    title_lower = item['title'].lower()
                    if any(keyword in title_lower for keyword in ai_keywords):
                        news_items.append({
                            "title": item['title'],
                            "url": item.get('url', f"https://news.ycombinator.com/item?id={story_id}"),
                            "source": "Hacker News",
                            "date": datetime.datetime.fromtimestamp(item.get('time', 0)).strftime('%Y-%m-%d'),
                            "score": item.get('score', 0)
                        })
                        
                        if len(news_items) >= 8:
                            break
            except Exception:
                continue
                
        # --- ДОБАВЛЯЕМ ДАТУ ОБНОВЛЕНИЯ ---
        result = {
            "last_updated": datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
            "news": news_items
        }
                
        with open('news.json', 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
            
        print(f"✅ Успешно обновлено. Найдено {len(news_items)} новостей. Время: {result['last_updated']}")
        
    except Exception as e:
        print(f"❌ Ошибка при сборе новостей: {e}")

if __name__ == "__main__":
    fetch_ai_news()
