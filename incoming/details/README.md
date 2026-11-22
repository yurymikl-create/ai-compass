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

Ключ верхнего уровня — `id` сервиса. Внутри — блоки, все текстовые поля
двуязычные (`_ru` / `_en`), обе стороны обязательны.

```json
{
  "deepseek": {
    "tagline_ru": "Одна фраза в 8–14 слов: чем сервис известен.",
    "tagline_en": "One phrase, 8–14 words.",
    "what_ru": "2–4 предложения: что это, для чего, что умеет. Без маркетинга.",
    "what_en": "2–4 sentences: what it is, what it is for.",
    "company_ru": "Компания, страна, год основания.",
    "company_en": "Company, country, founded year.",
    "positioning_ru": "Место сервиса среди соседей по категории — без сравнений.",
    "positioning_en": "Where the service sits among its peers — without comparisons.",
    "history_ru": "Как сервис появился и что менялось по ходу развития.",
    "history_en": "How the service appeared and what changed over time.",
    "overview_ru": [
      "Абзац 1: как устроен рабочий процесс.",
      "Абзац 2: что происходит внутри, чем ответ отличается от действия.",
      "Абзац 3: как устроены проекты и повторяющиеся задачи.",
      "Абзац 4: в чём практическая ценность и что остаётся за пользователем."
    ],
    "overview_en": ["Paragraph 1.", "Paragraph 2.", "Paragraph 3.", "Paragraph 4."],
    "features_ru": ["3–6 пунктов", "конкретные функции"],
    "features_en": ["3–6 items", "concrete features"],
    "limits_ru": ["2–3 честных ограничения"],
    "limits_en": ["2–3 honest limitations"],
    "best_for_ru": [
      { "audience": "Кому подходит", "reason": "Почему именно ему" }
    ],
    "best_for_en": [
      { "audience": "Who it suits", "reason": "Why it suits them" }
    ],
    "not_for_ru": ["Кому не подходит и почему"],
    "not_for_en": ["Who it does not suit and why"],
    "limitations_detail_ru": [
      { "limitation": "Ограничение", "user_impact": "Что это значит на практике" }
    ],
    "limitations_detail_en": [
      { "limitation": "Limitation", "user_impact": "What it means in practice" }
    ],
    "capabilities_ru": [
      {
        "title": "Название возможности",
        "description": "Что делает",
        "practical_value": "Зачем это пользователю"
      }
    ],
    "capabilities_en": [
      { "title": "Capability", "description": "What it does", "practical_value": "Why it matters" }
    ],
    "use_cases_ru": [
      {
        "title": "Сценарий",
        "input": "Что на входе",
        "workflow": "Как идёт работа",
        "output": "Что получается на выходе"
      }
    ],
    "use_cases_en": [
      { "title": "Scenario", "input": "Input", "workflow": "Workflow", "output": "Output" }
    ],
    "getting_started_ru": ["Шаг 1", "Шаг 2", "Шаг 3"],
    "getting_started_en": ["Step 1", "Step 2", "Step 3"],
    "product_details": {
      "product_type": "hosted AI assistant",
      "interfaces": ["web", "mobile"],
      "input_types": ["text", "files"],
      "output_types": ["text", "code"],
      "deployment_options": ["hosted"]
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
}
```

### Обязательные поля

`tagline_ru/en`, `what_ru/en`, `company_ru/en`, `positioning_ru/en`,
`history_ru/en`, `overview_ru/en`, `features_ru/en`, `limits_ru/en`,
`best_for_ru/en`, `not_for_ru/en`, `limitations_detail_ru/en`,
`capabilities_ru/en`, `use_cases_ru/en`, `getting_started_ru/en`,
`product_details`, `benchmarks`, `sources`, `updated_at`, `source`.

### Необязательные поля

`benchmarks` может быть пустым списком (`[]`) — у инструментов и агрегаторов
публичных замеров обычно нет. Это нормально и ожидаемо, не ошибка.

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
> **Обязательно:** все пары `_ru` / `_en` заполнены; `features` — 3–6 пунктов,
> `limits` — 2–3, `overview` — 3–4 абзаца, `best_for` и `limitations_detail` —
> списки объектов с полями из схемы. Ограничения должны быть настоящими, не
> «может ошибаться».
>
> **Формат ответа:** только JSON, без markdown-обёрток и комментариев.

## Проверка черновиков

```bash
python3 validate_details.py                   # вся папка incoming/details/
python3 validate_details.py --strict          # предупреждения считаются ошибками
python3 validate_details.py path/to/one.json  # один файл
```

Валидатор ничего не исправляет и не перезаписывает — только сообщает, что не
так. Код возврата `0` — всё чисто, `1` — есть ошибки.

Файлы с суффиксами `-validation.json` и `-report.json` — это отчёты о проверке,
а не черновики. Валидатор и `build_details.py` их пропускают, поэтому отчёт можно
класть рядом с черновиками, не переименовывая.

## Что происходит дальше

1. `python3 validate_details.py incoming/details/` — построчная проверка, ничего
   не пишется при ошибке.
2. Данные собираются в `service-details.json` в корне.
3. Ссылка «Подробнее» на карточке в каталоге ведёт на `service.html?id=<id>`.
