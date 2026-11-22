#!/usr/bin/env python3
"""Merge card drafts from incoming/details/ into service-details.json.

Why this file exists
--------------------
Drafts are per-service JSON files that anyone can drop into incoming/details/.
The public page needs one file it can fetch, keyed by id, with the identity
fields taken from the catalog so a card can never disagree with index.html about
who made the service or where it lives.

Behaviour
---------
* reads every *.json draft in incoming/details/ (a single file may hold many ids);
* takes identity from index.html (name, type, category, developer, country, url);
* keeps the draft text as-is, minus the identity fields it may duplicate;
* skips drafts whose id is not in the catalog and reports them;
* writes service-details.json only when at least one record is valid.

Usage
-----
    python3 build_details.py            # write service-details.json
    python3 build_details.py --dry-run  # report only
"""

import argparse
import datetime
import io
import json
import os
import re
import sys

DRAFTS_DIR = "incoming/details"
CATALOG = "index.html"
OUT_FILE = "service-details.json"

# Identity lives in the catalog, never in the draft: one source of truth.
IDENTITY_FIELDS = ("name", "type", "category", "developer", "developer_country", "url")


def load_catalog():
    """Return {id: {name, type, category, developer, developer_country, url}}."""
    text = io.open(CATALOG, encoding="utf-8").read()
    start = text.index("const services = [")
    end = text.index("];", start)
    block = text[start:end]

    out = {}
    for match in re.finditer(r"\{[^{}]*\bid:\s*\"([^\"]+)\"[^{}]*\}", block):
        entry = match.group(0)
        sid = match.group(1)

        def field(name):
            found = re.search(r"\b%s:\s*\"([^\"]*)\"" % name, entry)
            return found.group(1) if found else ""

        out[sid] = {
            "name": field("name"),
            "type": field("type"),
            "category": field("category"),
            "developer": field("developer"),
            "developer_country": field("developer_country"),
            "url": field("url"),
        }
    return out


def _is_report(name):
    """Validation reports sit next to drafts but are not drafts."""
    base = name.lower()
    return base.endswith("-validation.json") or base.endswith("-report.json")


def load_drafts(directory):
    """Return ({id: record}, [problems])."""
    records = {}
    problems = []
    if not os.path.isdir(directory):
        return records, ["drafts directory %r is missing" % directory]

    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json") or _is_report(name):
            continue
        path = os.path.join(directory, name)
        try:
            with io.open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except ValueError as exc:
            problems.append("%s: invalid JSON (%s)" % (name, exc))
            continue
        if not isinstance(data, dict):
            problems.append("%s: top level is not an object" % name)
            continue
        for sid, record in data.items():
            if not isinstance(record, dict):
                problems.append("%s: %r is not an object" % (name, sid))
                continue
            records[sid] = record
    return records, problems


def merge(identity, record):
    """Identity from the catalog wins; the draft supplies the text."""
    merged = dict(identity)
    for key, value in record.items():
        if key in IDENTITY_FIELDS:
            continue
        merged[key] = value
    return merged


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    args = parser.parse_args(argv)

    catalog = load_catalog()
    drafts, problems = load_drafts(DRAFTS_DIR)

    services = {}
    skipped = []
    for sid in sorted(drafts):
        if sid not in catalog:
            skipped.append(sid)
            continue
        services[sid] = merge(catalog[sid], drafts[sid])

    for problem in problems:
        print("  warn  %s" % problem)
    if skipped:
        print("  skip  id not in catalog: %s" % ", ".join(skipped))

    print("catalog ids: %d | drafts: %d | merged: %d"
          % (len(catalog), len(drafts), len(services)))

    if not services:
        print("nothing to write")
        return 1

    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "note": "Rendered by service.html. Identity comes from index.html; text comes "
                "from incoming/details drafts. Access level is deliberately absent: "
                "it stays on the catalog card.",
        "count": len(services),
        "services": services,
    }

    if args.dry_run:
        print("dry run: would write %s with %d service(s)" % (OUT_FILE, len(services)))
        return 0

    with io.open(OUT_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("wrote %s with %d service(s)" % (OUT_FILE, len(services)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
