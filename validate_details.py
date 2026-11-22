#!/usr/bin/env python3
"""Validate service-card drafts in incoming/details/.

Why this file exists
--------------------
Card texts are generated outside the pipeline (by a person or by another AI) and
dropped into incoming/details/. Nothing there is trusted: a missing translation,
a fabricated benchmark or a sentence about payments would reach the public page
unchecked. This script is the gate between the draft folder and the catalog.

What it checks
--------------
* every record has the required fields and both languages of each pair;
* features are 3-6 items, limits are 2-3, none of them empty;
* every benchmark carries a source and a date -- a number without a source is
  a guess and is rejected;
* updated_at is a real ISO date and not in the future;
* forbidden concepts (availability in Belarus, VPN, payment, cards, prices) do
  not appear in the text -- matching is stem-based and case-insensitive, so
  "недоступно" and "Недоступность" are caught, while "доступ к API" is not;
* the id exists in the catalog (skipped with a warning while the catalog has no
  ids yet).

What it does NOT do
-------------------
It never rewrites the drafts and never writes service-details.json. It only
reports. Fixing a fact is a human decision, not a script's.

Usage
-----
    python3 validate_details.py                          # incoming/details/
    python3 validate_details.py incoming/details/         # same, explicit
    python3 validate_details.py path/to/one.json          # a single file
    python3 validate_details.py --strict                  # warnings count as errors
"""

import argparse
import datetime
import io
import json
import os
import re
import sys

DEFAULT_DIR = "incoming/details"
CATALOG_FILE = "index.html"

# Fields every record must carry. A card without these cannot be rendered.
REQUIRED = (
    "tagline_ru", "tagline_en",
    "what_ru", "what_en",
    "company_ru", "company_en",
    "features_ru", "features_en",
    "limits_ru", "limits_en",
    "overview_ru", "overview_en",
    "best_for_ru", "best_for_en",
    "not_for_ru", "not_for_en",
    "limitations_detail_ru", "limitations_detail_en",
    "capabilities_ru", "capabilities_en",
    "use_cases_ru", "use_cases_en",
    "getting_started_ru", "getting_started_en",
    "history_ru", "history_en",
    "positioning_ru", "positioning_en",
    "product_details", "benchmarks", "sources",
    "updated_at", "source",
)

# Pairs that must both exist and both be non-empty.
PAIRS = (
    ("tagline_ru", "tagline_en"),
    ("what_ru", "what_en"),
    ("company_ru", "company_en"),
    ("features_ru", "features_en"),
    ("limits_ru", "limits_en"),
    ("overview_ru", "overview_en"),
    ("best_for_ru", "best_for_en"),
    ("not_for_ru", "not_for_en"),
    ("limitations_detail_ru", "limitations_detail_en"),
    ("capabilities_ru", "capabilities_en"),
    ("use_cases_ru", "use_cases_en"),
    ("getting_started_ru", "getting_started_en"),
    ("history_ru", "history_en"),
    ("positioning_ru", "positioning_en"),
)

# Stem-based: "недоступн" also catches "недоступно" and "недоступность".
# "доступ" alone is deliberately absent -- "доступ к API" is legitimate.
FORBIDDEN = (
    "недоступн",
    "vpn",
    "беларус",
    "оплат",
    "подписк",
    "byn",
    "бесплатн",
    "платн",
    "банковск",
    "рубл",
    "доллар",
)

# Where a forbidden stem may legitimately appear. Kept short on purpose: each
# entry is a deliberate exception, not a way to silence the check.
ALLOWED_CONTEXTS = (
    "доступ к api",
    "доступ к репозиторию",
    "доступ к документам",
    "права доступа",
    "доступом к источникам",
    "доступное оборудование",
    "доступность системы",
    "доступные настройки",
)

VALID_SOURCES = ("ai", "manual")


def catalog_ids(path=CATALOG_FILE):
    """Ids present in the catalog's const services array.

    The catalog may not carry ids yet (they are added in a separate step), so an
    empty set is not an error -- callers skip the id check in that case.
    """
    try:
        text = io.open(path, encoding="utf-8").read()
    except OSError:
        return set()
    start = text.find("const services = [")
    if start < 0:
        return set()
    end = text.find("\n        ];", start)
    if end < 0:
        end = text.find("];", start)
    block = text[start:end if end > 0 else len(text)]
    return set(re.findall(r'\bid:\s*"([^"]+)"', block))


def load_records(path):
    """Return ({id: record}, [problems], [warnings]) from a file or a folder.

    An empty folder is not an error: the drafts are gitignored, so a fresh clone
    has none. It is reported as a warning instead.
    """
    records = {}
    problems = []
    warnings = []

    def take(obj, origin):
        if not isinstance(obj, dict):
            problems.append("%s: top level is %s, expected an object"
                            % (origin, type(obj).__name__))
            return
        for key, value in obj.items():
            if isinstance(value, dict):
                records[key] = value
            else:
                problems.append("%s: '%s' is %s, expected an object"
                                % (origin, key, type(value).__name__))

    if os.path.isdir(path):
        names = sorted(n for n in os.listdir(path) if n.endswith(".json"))
        if not names:
            warnings.append("%s: no *.json drafts yet" % path)
        for name in names:
            full = os.path.join(path, name)
            try:
                with io.open(full, encoding="utf-8") as handle:
                    take(json.load(handle), name)
            except ValueError as exc:
                problems.append("%s: invalid JSON (%s)" % (name, exc))
    elif os.path.isfile(path):
        try:
            with io.open(path, encoding="utf-8") as handle:
                take(json.load(handle), os.path.basename(path))
        except ValueError as exc:
            problems.append("%s: invalid JSON (%s)" % (path, exc))
    else:
        problems.append("%s: not found" % path)

    return records, problems, warnings


def _text_of(value):
    """Flatten a field to plain text for the forbidden-word scan."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(_text_of(item) for item in value)
    if isinstance(value, dict):
        return " ".join(_text_of(item) for item in value.values())
    return ""


def _blank(value):
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return value is None


def _iso_date_ok(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def validate_record(rid, rec, known_ids):
    """Return (errors, warnings) for one record."""
    errors = []
    warnings = []

    missing = [field for field in REQUIRED if field not in rec]
    if missing:
        errors.append("missing fields: %s" % ", ".join(missing))

    for ru, en in PAIRS:
        if ru in rec and en in rec and (_blank(rec[ru]) or _blank(rec[en])):
            errors.append("%s / %s: one side is empty" % (ru, en))

    features = rec.get("features_ru")
    if isinstance(features, list):
        if not 3 <= len(features) <= 6:
            errors.append("features_ru: %d items, expected 3-6" % len(features))
    elif "features_ru" in rec:
        errors.append("features_ru: not a list")

    limits = rec.get("limits_ru")
    if isinstance(limits, list):
        if not 2 <= len(limits) <= 3:
            errors.append("limits_ru: %d items, expected 2-3" % len(limits))
    elif "limits_ru" in rec:
        errors.append("limits_ru: not a list")

    benchmarks = rec.get("benchmarks")
    if isinstance(benchmarks, list):
        for index, item in enumerate(benchmarks):
            if not isinstance(item, dict):
                errors.append("benchmarks[%d]: not an object" % index)
                continue
            for field in ("name", "value", "source", "date"):
                if _blank(item.get(field)):
                    errors.append("benchmarks[%d]: missing %s" % (index, field))
    elif "benchmarks" in rec:
        errors.append("benchmarks: not a list")

    updated = rec.get("updated_at")
    if not _iso_date_ok(updated):
        errors.append("updated_at: not an ISO date (%r)" % (updated,))
    elif datetime.date.fromisoformat(updated) > datetime.date.today():
        errors.append("updated_at: in the future (%s)" % updated)

    source = rec.get("source")
    if source not in VALID_SOURCES:
        errors.append("source: %r, expected one of %s"
                      % (source, ", ".join(VALID_SOURCES)))

    text = _text_of(rec).lower()
    for allowed in ALLOWED_CONTEXTS:
        text = text.replace(allowed, " ")
    for stem in FORBIDDEN:
        if stem in text:
            errors.append("forbidden concept: %r" % stem)

    if known_ids and rid not in known_ids:
        errors.append("id %r is not in the catalog" % rid)
    elif not known_ids:
        warnings.append("catalog has no ids yet -- id check skipped")

    return errors, warnings


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Validate service-card drafts in incoming/details/.")
    parser.add_argument("path", nargs="?", default=DEFAULT_DIR,
                        help="a folder or a single JSON file (default: %s)" % DEFAULT_DIR)
    parser.add_argument("--strict", action="store_true",
                        help="treat warnings as errors")
    args = parser.parse_args(argv)

    records, problems, warnings = load_records(args.path)
    known = catalog_ids()

    errors = list(problems)
    for rid in sorted(records):
        found, notes = validate_record(rid, records[rid], known)
        errors.extend("%s: %s" % (rid, item) for item in found)
        warnings.extend("%s: %s" % (rid, item) for item in notes)

    for item in errors:
        print("  FAIL  %s" % item)
    for item in warnings:
        print("  warn  %s" % item)

    failed = len(errors) + (len(warnings) if args.strict else 0)
    print("SUMMARY  records=%d  errors=%d  warnings=%d  %s"
          % (len(records), len(errors), len(warnings),
             "OK" if failed == 0 else "FAILED"))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
