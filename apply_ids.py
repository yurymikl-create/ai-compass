#!/usr/bin/env python3
"""Insert an `id` slug into every service entry in index.html.

Why this file exists
--------------------
Detail pages address a service as service.html?id=<slug>, and service-details.json
is keyed by the same slug. The catalog in index.html has no id field, so there is
nothing to join on. This script applies the mapping from service-ids.json to the
catalog once, deterministically.

Behaviour
---------
* only touches the `const services = [...]` block, never the rest of the file;
* skips entries that already carry an id (safe to re-run);
* refuses to write when the number of replacements does not match the mapping,
  because a silent partial edit is worse than no edit;
* dry-run by default; pass --write to change the file.

Usage
-----
    python3 apply_ids.py            # show what would change
    python3 apply_ids.py --write    # apply and save
"""

import argparse
import io
import json
import re
import sys

CATALOG = "index.html"
IDS_FILE = "service-ids.json"
START = "const services = ["


def load_ids(path=IDS_FILE):
    with io.open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    return data["ids"]


def services_block(text):
    """Return (start, end) indices of the services array body."""
    start = text.find(START)
    if start < 0:
        raise SystemExit("cannot find %r in %s" % (START, CATALOG))
    end = text.find("\n        ];", start)
    if end < 0:
        end = text.find("];", start)
    if end < 0:
        raise SystemExit("cannot find the end of the services array")
    return start, end


def apply_ids(text, mapping):
    """Return (new_text, applied, skipped, problems)."""
    start, end = services_block(text)
    block = text[start:end]
    applied = []
    skipped = []
    problems = []

    for name, slug in mapping.items():
        needle = '{ name: "%s",' % name
        replacement = '{ id: "%s", name: "%s",' % (slug, name)
        already = '{ id: "%s", name: "%s",' % (slug, name)
        count = block.count(needle)
        if count == 0:
            if already in block:
                skipped.append(name)
            else:
                problems.append("entry not found: %s" % name)
            continue
        if count > 1:
            problems.append("entry appears %d times: %s" % (count, name))
            continue
        block = block.replace(needle, replacement, 1)
        applied.append(name)

    return text[:start] + block + text[end:], applied, skipped, problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help="save changes to index.html")
    args = parser.parse_args(argv)

    mapping = load_ids()
    text = io.open(CATALOG, encoding="utf-8").read()
    new_text, applied, skipped, problems = apply_ids(text, mapping)

    print("mapping: %d service(s)" % len(mapping))
    print("applied: %d" % len(applied))
    print("already had an id: %d" % len(skipped))
    for name in problems:
        print("PROBLEM: %s" % name)

    if problems:
        print("REFUSING to write: %d problem(s)" % len(problems))
        return 1

    if args.write and applied:
        with io.open(CATALOG, "w", encoding="utf-8") as handle:
            handle.write(new_text)
        print("wrote %s" % CATALOG)
    elif not applied:
        print("nothing to do")
    else:
        print("dry run: pass --write to save")
    return 0


if __name__ == "__main__":
    sys.exit(main())
