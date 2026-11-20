#!/usr/bin/env python3
"""Lifecycle checker for AI Compass.

One question per service: "does this service still exist and answer?"
Deliberately NOT: "is it reachable from Belarus?"

Those are two different axes and the catalog keeps them apart:
  * access_level / vpn  -> curated knowledge about Belarus. This script never
    reads or writes those fields, so a red "blocked in BY" badge can never be
    turned into "the service is dead" by an HTTP probe.
  * status.json         -> observed lifecycle. That is what this script writes.

States written to status.json:
  ok           the site answered (200-399, same host)
  moved        the site answers but redirects to another domain (a subdomain
               redirect, e.g. a geo-restriction page, does not count as a move)
  unverified   not confirmed: 403/429/451 seen from the US runner, a TLS handshake
               failure, a timeout or a 5xx, or a single hard failure that has not
               repeated yet. No badge is shown for this state.
  inactive     the probe failed with a hard error (DNS, refused, 404/410)
               FAIL_THRESHOLD times in a row
  deprecated   set by hand in status-overrides.json (the product is outdated)
  shutdown     set by hand in status-overrides.json (the vendor closed it)

Manual knowledge always wins over the probe: entries in status-overrides.json
are applied last and can also force state "ok" to silence a false positive.

Usage:
  python3 check_status.py            # probe everything, write status.json
  python3 check_status.py --dry-run  # print the table, write nothing
  python3 check_status.py --limit 5  # quick smoke run on the first 5 services
  python3 check_status.py --timeout 8
"""

import argparse
import datetime
import json
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = "AI-Compass-Status-Bot/1.0 (+https://github.com/yurymikl-create/ai-compass)"
CATALOG_FILE = "index.html"
STATUS_FILE = "status.json"
OVERRIDES_FILE = "status-overrides.json"

FAIL_THRESHOLD = 2      # consecutive failed probes before a service counts as inactive
MAX_WORKERS = 8
DEFAULT_TIMEOUT = 20   # some catalogued sites need 10-15s; a tight timeout is a false positive

LIVE_STATES = ("ok", "moved", "unverified")
STALE_STATES = ("inactive", "deprecated", "shutdown")
ALL_STATES = LIVE_STATES + STALE_STATES
PROBE_STATES = ("ok", "moved", "dead", "unreachable", "forbidden")

# human wording for the machine reason codes, used in the generated notes
REASON_TEXT = {
    "dns": ("the domain does not resolve", "домен не разрешается"),
    "refused": ("the server refused the connection", "сервер отклонил подключение"),
    "timeout": ("the server did not answer in time", "сервер не ответил вовремя"),
    "tls": ("the TLS handshake failed (often an old client or a strict server)",
            "рукопожатие TLS не удалось (часто из-за старого клиента или строгого сервера)"),
    "network": ("the network request failed", "сетевой запрос не удался"),
    "http-404": ("the server returned 404", "сервер вернул 404"),
    "http-410": ("the server returned 410 (gone)", "сервер вернул 410 (ресурс удалён)"),
    "http-5xx": ("the server returned a 5xx error", "сервер вернул ошибку 5xx"),
}


def host_of(url):
    """Hostname without a leading www, so example.com and www.example.com match."""
    try:
        host = urllib.parse.urlsplit(url).netloc.lower()
    except ValueError:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host.split(":")[0]


def base_domain(host):
    """Heuristic registrable domain: the last two labels.

    Enough to tell a real move (claude.ai -> claude.com) from a subdomain redirect
    (elevenlabs.io -> geo-restriction.elevenlabs.io, which is a geo block, not a move).
    """
    parts = [p for p in (host or "").split(".") if p]
    if len(parts) <= 2:
        return host
    return ".".join(parts[-2:])


# A redirect to a sign-in page is not a move: the product still lives where it lived,
# the visitor is just asked to log in first. Shedevrum -> passport.yandex.ru is the
# classic case; without this guard it would be reported as "the site moved".
AUTH_HOST_PREFIXES = (
    "passport.", "login.", "signin.", "accounts.", "account.",
    "auth.", "sso.", "id.", "oauth.", "secure.", "my.",
)


def is_auth_host(host):
    """True when the redirect target is a sign-in page rather than a new home."""
    host = (host or "").lower()
    return any(host.startswith(prefix) for prefix in AUTH_HOST_PREFIXES)


def load_services(path=CATALOG_FILE):
    """Every `{ name: "...", ..., url: "..." }` row of the catalog literal."""
    with open(path, encoding="utf-8") as handle:
        html = handle.read()
    start = html.find("const services = [")
    end = html.find("\n        ];", start)
    block = html[start:end] if start >= 0 and end >= 0 else html
    out = []
    for line in block.splitlines():
        if "name:" not in line or "url:" not in line:
            continue
        name = _first(line, r'name:\s*"([^"]+)"')
        url = _first(line, r'url:\s*"([^"]+)"')
        if name and url:
            out.append((name, url))
    return out


def _first(text, pattern):
    import re
    match = re.search(pattern, text)
    return match.group(1) if match else ""


# ------------------------------------------------------------------- probing
def probe(url, timeout=DEFAULT_TIMEOUT):
    """Ask the site once. Returns (probe_state, http_code, reason, final_host).

    probe_state is one of PROBE_STATES. Redirects are followed, so "moved" means
    "the browser ends up on a different host than the URL in the catalog".
    """
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            code = response.getcode()
            final = response.geturl() or url
            try:
                response.read(4096)  # drain a little so the socket closes cleanly
            except Exception:
                pass
        final_host = host_of(final)
        if 200 <= code < 400:
            if is_auth_host(final_host):
                # login wall, not a new home: the service is still reachable
                return "ok", code, "auth-redirect", final_host
            if final_host and base_domain(final_host) != base_domain(host_of(url)):
                return "moved", code, "ok", final_host
            return "ok", code, "ok", final_host
        return "unreachable", code, "http-5xx", final_host
    except urllib.error.HTTPError as exc:
        code = exc.code
        if code in (404, 410):
            return "dead", code, "http-" + str(code), host_of(url)
        if code in (403, 429, 451):
            # the runner sits in the US: "forbidden" is usually about the IP, not the product
            return "forbidden", code, "http-" + str(code), host_of(url)
        if code >= 500:
            return "unreachable", code, "http-5xx", host_of(url)
        # 400/401/402/405 and friends still prove the site is alive
        return "ok", code, "http-" + str(code), host_of(url)
    except urllib.error.URLError as exc:
        reason = exc.reason
        text = str(reason)
        if isinstance(reason, socket.gaierror) or "Name or service not known" in text \
                or "nodename nor servname" in text or "Temporary failure in name resolution" in text:
            return "dead", None, "dns", host_of(url)
        if isinstance(reason, ConnectionRefusedError) or "Connection refused" in text:
            return "dead", None, "refused", host_of(url)
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in text.lower():
            return "unreachable", None, "timeout", host_of(url)
        if isinstance(reason, ssl.SSLError):
            # a TLS handshake failure can be our client's fault, not the site's: verify, don't accuse
            return "forbidden", None, "tls", host_of(url)
        return "unreachable", None, "network", host_of(url)
    except (socket.timeout, TimeoutError):
        return "unreachable", None, "timeout", host_of(url)
    except ssl.SSLError:
        return "forbidden", None, "tls", host_of(url)
    except Exception as exc:  # noqa: BLE001 - a probe must never crash the run
        return "unreachable", None, "network:" + type(exc).__name__, host_of(url)


def resolve_state(probe_state, failures):
    """Turn one probe result into a lifecycle state plus the new failure counter.

    `failures` is the number of consecutive hard failures INCLUDING this one.
    Only hard failures count towards "inactive": a timeout or a 5xx is usually a slow
    site or a network hiccup, not proof that the product is gone. Those stay
    "unverified" and get no badge on the card.
    """
    if probe_state in ("ok", "moved"):
        return probe_state, 0
    if probe_state in ("forbidden", "unreachable"):
        return "unverified", 0
    # dead: dns / refused / 404 / 410 — one bad night is still not a closed product
    return ("inactive" if failures >= FAIL_THRESHOLD else "unverified"), failures


def make_note(state, reason, failures, final_host, url):
    """Bilingual, honest wording for every non-ok state."""
    if state in ("ok", ""):
        return "", ""
    if state == "moved":
        return (f"The site now redirects to {final_host}.",
                f"Сайт теперь перенаправляет на {final_host}.")
    if state == "unverified":
        if reason.startswith("http-4"):
            return ("The probe got a refusal from the US server, so the service could not be "
                    "confirmed. That usually means the site blocks foreign IPs, not that it is gone.",
                    "Проверка получила отказ с сервера в США, поэтому сервис не подтверждён. "
                    "Обычно это значит, что сайт блокирует зарубежные IP, а не что он закрыт.")
        en, ru = REASON_TEXT.get(reason, ("the probe failed", "проверка не прошла"))
        return (f"One check failed because {en}; not confirmed yet, so nothing is marked on the card.",
                f"Одна проверка не прошла: {ru}. Пока не подтверждено, поэтому на карточке ничего не помечено.")
    if state == "inactive":
        en, ru = REASON_TEXT.get(reason, ("the probe failed", "проверка не прошла"))
        return (f"The service did not answer {failures} checks in a row because {en}.",
                f"Сервис не ответил {failures} проверки подряд: {ru}.")
    if state == "deprecated":
        return ("The product is outdated; a replacement is usually available.",
                "Продукт устарел; обычно есть замена.")
    if state == "shutdown":
        return ("The vendor has closed this service.",
                "Вендор закрыл этот сервис.")
    return "", ""


# -------------------------------------------------------------- previous run
def load_previous(path=STATUS_FILE):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    services = data.get("services") or {}
    return services if isinstance(services, dict) else {}


def load_overrides(path=OVERRIDES_FILE):
    """Manual facts about products; keys starting with _ are documentation."""
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as exc:
        print(f"  ! {path}: {exc} (continuing without overrides)")
        return {}
    raw = data.get("overrides") or {}
    return {k: v for k, v in raw.items() if isinstance(v, dict) and not k.startswith("_")}


def apply_override(record, override):
    state = str(override.get("state") or "").strip().lower()
    if state not in ALL_STATES:
        return record
    record["state"] = state
    record["source"] = "override"
    record["note_en"] = str(override.get("note_en") or "")
    record["note_ru"] = str(override.get("note_ru") or "")
    if override.get("since"):
        record["since"] = str(override["since"])
    if override.get("successor"):
        record["successor"] = str(override["successor"])
    return record


# ---------------------------------------------------------------------- main
def main():
    parser = argparse.ArgumentParser(description="Probe every catalog service and write status.json")
    parser.add_argument("--dry-run", action="store_true", help="print the table, write nothing")
    parser.add_argument("--limit", type=int, default=0, help="probe only the first N services")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="per-request timeout in seconds")
    args = parser.parse_args()

    now = datetime.datetime.now(datetime.timezone.utc)
    today = now.date().isoformat()

    try:
        services = load_services()
    except FileNotFoundError:
        print(f"! {CATALOG_FILE} not found")
        return 1
    if not services:
        print("! no services parsed from the catalog")
        return 1
    if args.limit:
        services = services[: args.limit]

    previous = load_previous()
    overrides = load_overrides()

    print(f"AI Compass - lifecycle check ({len(services)} services, {MAX_WORKERS} workers)")
    print("Reminder: access_level / vpn are curated knowledge and are never touched here.")

    results = {}

    def run_one(pair):
        name, url = pair
        prev = previous.get(name) or {}
        failures = int(prev.get("consecutive_failures") or 0)
        probe_state, code, reason, final_host = probe(url, args.timeout)
        state, failures = resolve_state(probe_state, failures)
        if probe_state == "dead":
            failures += 1
        state, failures = resolve_state(probe_state, failures)
        note_en, note_ru = make_note(state, reason, failures, final_host, url)
        return name, {
            "state": state,
            "probe": probe_state,
            "http": code,
            "reason": reason,
            "url": url,
            "host": host_of(url),
            "final_host": final_host,
            "checked_at": today,
            "consecutive_failures": failures,
            "note_en": note_en,
            "note_ru": note_ru,
            "source": "probe",
        }

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for name, record in pool.map(run_one, services):
            results[name] = record

    # manual knowledge wins over the probe
    unknown = [name for name in overrides if name not in results]
    for name in unknown:
        print(f"  ! override for unknown service: {name}")

    for name, override in overrides.items():
        if name in results:
            results[name] = apply_override(results[name], override)

    counts = {}
    for record in results.values():
        counts[record["state"]] = counts.get(record["state"], 0) + 1
    for state in ALL_STATES:
        if counts.get(state):
            print(f"  {state:12s} {counts[state]}")

    stale = [name for name, r in results.items() if r["state"] in STALE_STATES]
    if stale:
        print("  stale: " + ", ".join(stale))
    moved = [name for name, r in results.items() if r["state"] == "moved"]
    if moved:
        print("  moved: " + ", ".join(moved))

    if args.dry_run:
        print("dry run: status.json not written")
        for name, record in results.items():
            if record["state"] != "ok":
                print(f"  {name:28s} {record['state']:12s} {record['probe']:12s} {record['reason']}")
        return 0

    payload = {
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_by": "check_status.py",
        "fail_threshold": FAIL_THRESHOLD,
        "note": "Lifecycle only. Access from Belarus lives in access_level/vpn in index.html and is not probed here.",
        "counts": counts,
        "services": results,
    }
    with open(STATUS_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"OK  wrote {STATUS_FILE}: {len(results)} services, {len(stale)} stale")
    return 0


if __name__ == "__main__":
    sys.exit(main())
