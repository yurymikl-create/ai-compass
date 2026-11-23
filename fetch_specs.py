#!/usr/bin/env python3
"""Model specification collector for AI Compass.

Reads the explicit map in specs-mapping.json, asks OpenRouter for its model
catalog and writes model-specs.json with context length and prices for the
services the map points at.

The map is the only source of truth for matching. A service without a mapped
OpenRouter id gets no specs block, and the script never guesses by name: if a
mapped model disappears from the API it is reported as missing instead of being
silently replaced by a similarly named row. That keeps a wrong number off the
page at the cost of a stale one.

Usage:  python3 fetch_specs.py [--api URL] [--mapping FILE] [--out FILE] [--timeout SEC]
Exit code 0 when model-specs.json was written, 1 when the API could not be read,
no mapped model was found, or the output failed its own sanity checks.
"""

import argparse
import datetime
import json
import sys
import urllib.error
import urllib.request

API = "https://openrouter.ai/api/v1/models"
MAPPING = "specs-mapping.json"
OUT = "model-specs.json"
UA = "AI-Compass-Bot/1.0"
NOW = datetime.datetime.now(datetime.timezone.utc)


def fetch_models(api, timeout):
    """Return the raw model list from OpenRouter, or raise RuntimeError."""
    request = urllib.request.Request(api, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} from {api}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"network error for {api}: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{api} did not return JSON: {exc}") from exc

    data = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(data, list) or not data:
        raise RuntimeError(f"{api} returned no model list")
    return data


def load_mapping(path):
    with open(path, encoding="utf-8") as handle:
        mapping = json.load(handle)
    services = mapping.get("services")
    if not isinstance(services, dict) or not services:
        raise RuntimeError(f"{path} has no 'services' object")
    return services


def per_mtok(value):
    """OpenRouter prices are USD per token; the page shows USD per 1M tokens."""
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < 0:
        return None
    return round(number * 1_000_000, 4)


def build_spec(model, match):
    """Turn one OpenRouter row into the compact record the page renders."""
    pricing = model.get("pricing") or {}
    top = model.get("top_provider") or {}
    architecture = model.get("architecture") or {}
    context = model.get("context_length") or top.get("context_length")
    try:
        context = int(context) if context is not None else None
    except (TypeError, ValueError):
        context = None

    spec = {
        "openrouter": model.get("id"),
        "model": model.get("name") or model.get("id"),
        "match": match,
        "context_length": context,
        "max_completion_tokens": top.get("max_completion_tokens"),
        "price_prompt_per_mtok": per_mtok(pricing.get("prompt")),
        "price_completion_per_mtok": per_mtok(pricing.get("completion")),
        "modality": architecture.get("modality"),
        "knowledge_cutoff": model.get("knowledge_cutoff"),
        "url": "https://openrouter.ai/" + str(model.get("id") or ""),
    }
    # An alias row resolves to another model; naming the target keeps the block
    # honest about what the numbers actually belong to.
    if model.get("alias_target"):
        spec["alias_target"] = model["alias_target"]
    # Some rows price long context separately (for example Grok above 200k).
    # The base price is still shown, but the page warns that a second tier exists.
    if isinstance(pricing.get("overrides"), list) and pricing["overrides"]:
        spec["has_price_overrides"] = True
    return spec


def validate(specs):
    """Cheap sanity checks. A broken number is worse than a missing block."""
    problems = []
    for slug, spec in specs.items():
        if not spec.get("openrouter"):
            problems.append(f"{slug}: no openrouter id")
        context = spec.get("context_length")
        if not isinstance(context, int) or context <= 0:
            problems.append(f"{slug}: context_length is {context!r}")
        for key in ("price_prompt_per_mtok", "price_completion_per_mtok"):
            value = spec.get(key)
            if value is not None and not isinstance(value, (int, float)):
                problems.append(f"{slug}: {key} is {value!r}")
    return problems


def read_previous(path):
    """Return the existing output file, or None when there is nothing to compare."""
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def main():
    parser = argparse.ArgumentParser(description="Collect model specs from OpenRouter.")
    parser.add_argument("--api", default=API, help=f"models endpoint (default {API})")
    parser.add_argument("--mapping", default=MAPPING, help=f"explicit map (default {MAPPING})")
    parser.add_argument("--out", default=OUT, help=f"output file (default {OUT})")
    parser.add_argument("--timeout", type=int, default=30, help="per-request timeout in seconds")
    args = parser.parse_args()

    print("AI Compass - model specs collector")

    try:
        mapping = load_mapping(args.mapping)
    except (OSError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"! cannot read {args.mapping}: {exc}")
        return 1

    try:
        models = fetch_models(args.api, args.timeout)
    except RuntimeError as exc:
        print(f"! {exc}")
        return 1
    print(f"  API: {len(models)} models")

    by_id = {model.get("id"): model for model in models if model.get("id")}

    specs = {}
    missing = []
    unmapped = []
    for slug, entry in mapping.items():
        openrouter_id = (entry or {}).get("openrouter")
        if not openrouter_id:
            unmapped.append(slug)
            continue
        model = by_id.get(openrouter_id)
        if model is None:
            missing.append(openrouter_id)
            print(f"  ! {slug}: {openrouter_id} is not in the API response")
            continue
        specs[slug] = build_spec(model, entry.get("match") or "named")

    problems = validate(specs)
    if problems:
        print("! refusing to write model-specs.json:")
        for problem in problems:
            print(f"    {problem}")
        return 1
    if not specs:
        print("! no mapped model found in the API response - nothing to write")
        return 1

    counts = {
        "total": len(mapping),
        "mapped": len(specs),
        "missing": len(missing),
        "unmapped": len(unmapped),
    }

    # A weekly cron that rewrites the same numbers would commit a timestamp every
    # Monday. Keep the previous file when only generated_at would change, so the
    # workflow stays quiet and the date means "when the numbers last changed".
    previous = read_previous(args.out)
    if previous is not None:
        same = (
            previous.get("services") == specs
            and previous.get("missing") == missing
            and previous.get("counts") == counts
        )
        if same:
            print(
                "  unchanged since %s - %s left as is"
                % (previous.get("generated_at", "?"), args.out)
            )
            return 0

    result = {
        "generated_at": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": args.api,
        "counts": counts,
        "missing": missing,
        "services": specs,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    counts = result["counts"]
    print(
        f"OK  specs={counts['mapped']}  missing={counts['missing']}  "
        f"unmapped={counts['unmapped']}  at {result['generated_at']}"
    )
    if missing:
        print("  mapped ids that the API no longer lists: " + ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
