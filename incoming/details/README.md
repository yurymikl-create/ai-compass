# `incoming/details/` — черновики описаний для карточек сервисов

Сюда складываются JSON-файлы с описаниями сервисов. После проверки валидатором
данные переезжают в `service-details.json` в корне репозитория, а эта папка
остаётся только для черновиков.

**Файлы `*.json` в этой папке не попадают в git** (см. `.gitignore`): сайт
раздаётся из корня репозитория через GitHub Pages, поэтому черновик в корне
оказался бы публично доступен по прямой ссылке. Этот README отслеживается,
данные — нет.

## Имя файла

Имя файла = `id` сервиса из каталога, плюс `.json`:

```
incoming/details/deepseek.json
incoming/details/grammarly.json
```

Допустим и один общий файл `all.json` со словарём `{"deepseek": {...}, "grammarly": {...}}`.
Оба варианта принимаются.

Кодировка — UTF-8 без BOM.

## Схема записи

```json
{
  "id": "deepseek",
  "tagline_ru": "Одна фраза в 8–14 слов: чем сервис известен.",
  "tagline_en": "One phrase, 8–14 words.",
  "what_ru": "2–4 предложения: что это, для чего, что умеет. Без маркетинга.",
  "what_en": "2–4 sentences: what it is, what it is for.",
  "company_ru": "Компания, страна, год основания.",
  "company_en": "Company, country, founded year.",
  "features_ru": ["3–6 пунктов", "конкретные функции"],
  "features_en": ["3–6 items", "concrete features"],
  "limits_ru": ["2–3 честных ограничения"],
  "limits_en": ["2–3 honest limitations"],
  "specs": {
    "context_tokens": 128000,
    "parameters": "671B / 37B active",
    "licence": "MIT",
    "released": "2025-01",
    "modalities": ["text", "code"]
  },
  "benchmarks": [
    {
      "name": "Artificial Analysis Intelligence",
      "value": 62,
      "unit": "index",
      "source": "https://artificialanalysis.ai/",
      "date": "2026-11"
    }
  ],
  "sources": ["https://api-docs.deepseek.com/"],
  "updated_at": "2026-11-22",
  "source": "ai"
}
```

### Обязательные поля

`id`, `tagline_ru`, `tagline_en`, `what_ru`, `what_en`, `company_ru`,
`company_en`, `features_ru`, `features_en`, `limits_ru`, `limits_en`,
`updated_at`, `source`.

### Необязательные поля

`specs`, `benchmarks`, `sources`. У инструментов и агрегаторов публичных
замеров обычно нет — пустой `benchmarks: []` это нормально и ожидаемо.

## Правила

**Обязательно:**

- `features` — 3–6 пунктов, `limits` — 2–3, пустых быть не может;
- каждая цифра в `benchmarks` обязана иметь `source` и `date`;
- `updated_at` — дата в формате ISO (`YYYY-MM-DD`);
- `source` — `"ai"` если текст сгенерирован моделью, `"manual"` если написан человеком.

**Запрещено:**

- упоминать доступность в Беларуси, VPN, оплату, карты, подписки, цены, BYN;
- писать «требует проверки», «по данным на момент», «может быть устарело»;
- сравнивать с конкурентами напрямую («лучше, чем ChatGPT»);
- выдумывать цифры — нет источника, значит нет цифры;
- давать оценку вроде «мощная», «лучшая», «революционная» — вместо этого
  описать, **что именно** сервис делает.

## Список `id` — модели (28)

| id | Название | Разработчик | Страна |
|---|---|---|---|
| `chatgpt` | ChatGPT | OpenAI | US |
| `claude` | Claude | Anthropic | US |
| `gemini` | Gemini | Google | US |
| `deepseek` | DeepSeek | DeepSeek | CN |
| `qwen` | Qwen (Alibaba) | Alibaba | CN |
| `kimi` | Kimi (Moonshot AI) | Moonshot AI | CN |
| `minimax` | MiniMax (Hailuo AI) | MiniMax | CN |
| `zhipu-glm` | Zhipu AI (GLM) | Zhipu AI | CN |
| `gigachat` | GigaChat | Sberbank | RU |
| `alisa` | Алиса AI (Яндекс) | Yandex | RU |
| `perplexity` | Perplexity | Perplexity AI | US |
| `grok` | Grok (xAI) | xAI | US |
| `veda-ai` | Veda AI | Veda AI | RU |
| `dedii` | ДедИИ | Altspace | RU |
| `librachat` | LibraChat | LibraChat | KZ |
| `mistral-vibe` | Mistral Vibe (Le Chat) | Mistral AI | FR |
| `hunyuan` | Tencent Hunyuan (Yuanbao) | Tencent | CN |
| `stepfun` | StepFun (Step 5) | StepFun | CN |
| `mimo` | Xiaomi MiMo | Xiaomi | CN |
| `ernie` | Baidu ERNIE | Baidu | CN |
| `llama` | Meta Llama | Meta | US |
| `nemotron` | NVIDIA Nemotron | NVIDIA | US |
| `reflection-ai` | Reflection AI | Reflection AI | US |
| `inkling` | Thinking Machines (Inkling) | Thinking Machines | US |
| `microsoft-copilot` | Microsoft Copilot | Microsoft | US |
| `meta-ai` | Meta AI | Meta | US |
| `character-ai` | Character.AI | Character.AI | US |
| `you-com` | You.com | You.com | US |

## Список `id` — инструменты (43)

| id | Название | Разработчик | Страна |
|---|---|---|---|
| `cursor` | Cursor | Cursor | US |
| `midjourney` | Midjourney | Midjourney | US |
| `firefly` | Adobe Firefly | Adobe | US |
| `runway` | Runway | Runway | US |
| `elevenlabs` | ElevenLabs | ElevenLabs | US |
| `notebooklm` | NotebookLM | Google | US |
| `gamma` | Gamma | Gamma | US |
| `shedevrum` | Шедеврум (Яндекс) | Yandex | RU |
| `kandinsky` | Kandinsky (Сбер) | Sberbank | RU |
| `sourcecraft` | SourceCraft (Яндекс) | Yandex | RU |
| `gigacode` | GigaCode (Сбер) | Sberbank | RU |
| `cline` | Cline | Cline | US |
| `windsurf` | Windsurf | Windsurf | US |
| `github-copilot` | GitHub Copilot | GitHub | US |
| `replit` | Replit | Replit | US |
| `v0` | v0 (Vercel) | Vercel | US |
| `lovable` | Lovable | Lovable | US |
| `sora` | Sora (OpenAI) | OpenAI | US |
| `veo` | Veo (Google) | Google | US |
| `kling` | Kling (Kuaishou) | Kuaishou | CN |
| `pika` | Pika | Pika | US |
| `dream-machine` | Luma Dream Machine | Luma AI | US |
| `ideogram` | Ideogram | Ideogram | US |
| `leonardo-ai` | Leonardo AI | Leonardo | US |
| `suno` | Suno | Suno | US |
| `udio` | Udio | Udio | US |
| `ltx` | LTX-2.5 | Lightricks | IL |
| `amazon-q` | Amazon Q Developer | Amazon | US |
| `tabnine` | Tabnine | Tabnine | IL |
| `devin` | Devin (Cognition) | Cognition | US |
| `stable-diffusion` | Stable Diffusion (Stability AI) | Stability AI | GB |
| `dall-e` | DALL·E 3 (OpenAI) | OpenAI | US |
| `freepik` | Freepik | Freepik | ES |
| `synthesia` | Synthesia | Synthesia | GB |
| `heygen` | HeyGen | HeyGen | US |
| `capcut` | CapCut | ByteDance | CN |
| `descript` | Descript | Descript | US |
| `hume` | Hume AI | Hume AI | US |
| `notion-ai` | Notion AI | Notion | US |
| `canva` | Canva (Magic Studio) | Canva | AU |
| `grammarly` | Grammarly | Grammarly | US |
| `elicit` | Elicit | Elicit | US |
| `consensus` | Consensus | Consensus | US |

## Список `id` — агрегаторы (16)

| id | Название | Разработчик | Страна |
|---|---|---|---|
| `aiai-by` | AIAI.BY | AIAI.BY | BY |
| `mts-pomogai` | МТС PomogAI | MTS | BY |
| `yandex-ai-studio` | Yandex AI Studio | Yandex | RU |
| `openrouter` | OpenRouter | OpenRouter | US |
| `typingmind` | TypingMind | TypingMind | US |
| `poe` | Poe | Quora | US |
| `hugging-face` | Hugging Face | Hugging Face | US |
| `google-ai-studio` | Google AI Studio | Google | US |
| `groq` | Groq | Groq | US |
| `together-ai` | Together AI | Together AI | US |
| `fireworks-ai` | Fireworks AI | Fireworks AI | US |
| `replicate` | Replicate | Replicate | US |
| `nano-gpt` | Nano-GPT | Nano-GPT | US |
| `vsegpt` | VseGPT | VseGPT | RU |
| `bothub` | BotHub | BotHub | RU |
| `proxyapi` | ProxyAPI | ProxyAPI | RU |

## Промпт для генерации

> Ты заполняешь базу описаний AI-сервисов. Для каждого сервиса из списка выдай
> JSON по схеме из `README.md`.
>
> **Что писать:** что это за сервис, кем сделан, что умеет, в чём ограничен.
> Пиши для человека, который впервые слышит это название и хочет понять, нужен
> ли ему этот сервис.
>
> **Запрещено:** упоминать доступность в Беларуси, VPN, оплату, карты, подписки,
> цены; писать «требует проверки» и «может быть устарело»; сравнивать с
> конкурентами; выдумывать цифры — каждая цифра обязана иметь `source` и `date`.
>
> **Обязательно:** `tagline`, `what`, `company`, `features` (3–6), `limits`
> (2–3) — в двух вариантах, `_ru` и `_en`. Ограничения должны быть настоящими,
> не «может ошибаться».
>
> **Формат ответа:** только JSON, без markdown-обёрток и комментариев.

## Что происходит дальше

1. `python3 validate_details.py incoming/details/` — построчная проверка, ничего
   не пишется при ошибке.
2. Данные собираются в `service-details.json` в корне.
3. Ссылка «Подробнее» на карточке в каталоге ведёт на `service.html?id=<id>`.
