#!/usr/bin/env python3
"""Geo probe: does a service actually open from a Belarusian connection?

Why this file exists
--------------------
check_status.py runs on GitHub's US runners and answers one question: "does the
site still exist?" It cannot answer "is it reachable from Belarus?" -- from the US,
Grammarly, Perplexity and Midjourney all return 200 OK while a visitor in Minsk
sees "not available in your country". That mismatch is exactly what the catalog
used to get wrong.

This script asks the second question from a Belarusian connection. It writes
geo-checks.json and nothing else:

  * access_level / vpn in index.html stay hand-curated. One probe is not proof
    (a CDN edge may answer 200 while the app itself is blocked), so the probe never
    rewrites the catalog -- it only opens a review item for a human.
  * It must NOT run in GitHub Actions. The runners are in the US, so a "geo" probe
    there would reproduce the very lie this script exists to catch. Run it from a
    home connection in Belarus (launchd / cron) or by hand.

Verdicts
--------
  open           the page loaded and no blocking phrase was found
  blocked_page   451, or a "not available in your country" style page
  geo_redirect   the site redirected to a block / unavailable path
  refused        the connection was reset or refused
  timeout        no answer within the timeout
  unverified     a server error or an unclear answer; nothing is claimed

A blocked/refused verdict becomes "confirmed" only after two runs in a row, the
same two-strike rule check_status.py uses for "inactive".

Usage
-----
  python3 geo_probe.py                       # probe and print, write nothing
  python3 geo_probe.py --limit 5             # smoke test on five services
  python3 geo_probe.py --write               # also write geo-checks.json
  python3 geo_probe.py --write --push        # write, commit and push
  python3 geo_probe.py --all                 # every service, not just risky ones
  python3 geo_probe.py --skip-vantage-check  # testing only, claims nothing about BY
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import check_status as cs

GEO_FILE = "geo-checks.json"
CATALOG_FILE = "index.html"
BODY_BYTES = 32 * 1024        # enough to reach a "not available in your country" block
DEFAULT_TIMEOUT = 20
MAX_WORKERS = 8
CONFIRM_THRESHOLD = 2         # blocked/refused needs two runs in a row to be "confirmed"
RISKY_LEVELS = ("blocked", "limited")

GEO_NOTE = ("Verdicts from a Belarusian connection. Written by geo_probe.py, never by "
            "GitHub Actions (US runners cannot see a Belarusian geo-block). The file is "
            "a review queue: it never rewrites access_level in index.html. A service "
            "marked blocked often still serves its landing page, so 'open' here does not "
            "prove the app itself works.")

VERDICTS = ("open", "blocked_page", "geo_redirect", "refused", "forbidden",
            "challenge", "timeout", "unverified")
# A hard block: the visitor cannot get in and the reason is the region or the network.
BLOCK_VERDICTS = ("blocked_page", "geo_redirect", "refused")
# A bare 403 is weaker: it may be a geo-block or a bot challenge the browser would pass,
# so it is reported for review but never marked "confirmed".
SOFT_VERDICTS = ("forbidden",)

# Phrases that mean "this product is not offered where you are". Kept in both
# languages because several sites localise the message.
STRONG_PHRASES = (
    "not available in your country",
    "not available in your region",
    "not available in your location",
    "unavailable in your country",
    "unavailable in your region",
    "isn't available in your country",
    "is not available in your country",
    "this service is not available",
    "not available in belarus",
    "access is restricted in your region",
    "недоступно в вашей стране",
    "недоступен в вашей стране",
    "недоступно в вашем регионе",
    "недоступен в вашем регионе",
    "не доступно в вашей стране",
)
# Weaker wording: only treated as a block when the status code also says "forbidden".
WEAK_PHRASES = ("access denied", "forbidden", "доступ запрещён", "доступ запрещен")

# A 403 is usually Cloudflare's bot challenge, not a country block: the same address
# from a real browser opens fine. Treating those as "blocked" would mark half the
# catalogue as geo-blocked on the strength of a bot filter.
CHALLENGE_PHRASES = (
    "just a moment",
    "один момент",
    "cf-challenge",
    "cf-browser-verification",
    "attention required",
    "checking your browser",
    "enable javascript and cookies to continue",
    "ddos protection by",
    "security filter flagged",
)

BLOCK_PATHS = ("/blocked", "/unavailable", "/not-available", "/region-blocked",
               "/geo-blocked", "/country-blocked")

NOTE_RU = {
    "open": "Открывается с белорусского подключения",
    "blocked_page": "Показывает заглушку «недоступно в вашей стране»",
    "geo_redirect": "Перенаправляет на страницу блокировки",
    "refused": "Соединение сбрасывается или отклоняется",
    "forbidden": "Отказ 403 — возможно, гео-блок или защита от ботов",
    "challenge": "Страница проверки Cloudflare, а не блокировка по стране",
    "timeout": "Не ответил за отведённое время",
    "unverified": "Ответ неясный или серверная ошибка — вывода нет",
}
NOTE_EN = {
    "open": "Opens from a Belarusian connection",
    "blocked_page": "Shows a 'not available in your country' page",
    "geo_redirect": "Redirects to a block page",
    "refused": "Connection is reset or refused",
    "forbidden": "403 refusal -- a geo-block or a bot challenge",
    "challenge": "A Cloudflare challenge page, not a country block",
    "timeout": "No answer within the timeout",
    "unverified": "Unclear answer or server error -- nothing claimed",
}


def vantage():
    """Country of this connection. A VPN would silently turn the probe into a lie."""
    try:
        with urllib.request.urlopen("https://ipinfo.io/json", timeout=15) as response:
            info = json.loads(response.read(8192).decode("utf-8", "replace"))
    except Exception:
        return {}
    return {
        "country": str(info.get("country") or "").upper(),
        "ip": str(info.get("ip") or ""),
        "city": str(info.get("city") or ""),
        "provider": str(info.get("org") or ""),
    }


def load_catalog(path=CATALOG_FILE):
    """name -> {access_level, url}, parsed from the same literal check_status.py reads."""
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    start = text.find("const services = [")
    end = text.find("\n        ];", start)
    block = text[start:end] if start >= 0 and end > start else text
    catalog = {}
    for line in block.splitlines():
        name = cs._first(line, r'name:\s*"([^"]+)"')
        if not name:
            continue
        catalog[name] = {
            "access_level": cs._first(line, r'access_level:\s*"([^"]+)"'),
            "url": cs._first(line, r'url:\s*"([^"]+)"'),
        }
    return catalog


def classify(code, final_url, body, origin_url):
    """Turn one HTTP answer into a verdict + a short machine reason."""
    final_host = cs.host_of(final_url)
    if cs.is_auth_host(final_host):
        return "open", "auth-redirect"
    lowered = (body or "").lower()
    if code == 451:
        return "blocked_page", "http-451"
    path = urllib.parse.urlsplit(final_url or "").path.lower()
    for marker in BLOCK_PATHS:
        if marker in path:
            return "geo_redirect", "blocked-path"
    for phrase in STRONG_PHRASES:
        if phrase in lowered:
            return "blocked_page", "block-page"
    # A Cloudflare "Just a moment..." page is a bot filter, not a country block. It is
    # reported separately so it never becomes a false "blocked in BY" claim.
    for phrase in CHALLENGE_PHRASES:
        if phrase in lowered:
            return "challenge", "bot-challenge"
    if code in (401, 403):
        for phrase in WEAK_PHRASES:
            if phrase in lowered:
                return "blocked_page", "http-" + str(code)
        # A bare 403 from a Belarusian address: the visitor is refused, but a browser
        # might still pass a challenge, so this stays a soft signal for review.
        return "forbidden", "http-" + str(code)
    if code >= 500:
        return "unverified", "http-5xx"
    if 200 <= code < 400:
        return "open", "ok"
    return "unverified", "http-" + str(code)


def probe(url, timeout=DEFAULT_TIMEOUT):
    """Ask one site once. Returns (verdict, http_code, reason, final_host)."""
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": cs.UA,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "ru,en;q=0.8",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            code = response.getcode()
            final = response.geturl() or url
            try:
                body = response.read(BODY_BYTES).decode("utf-8", "replace")
            except Exception:
                body = ""
        verdict, reason = classify(code, final, body, url)
        return verdict, code, reason, cs.host_of(final)
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read(BODY_BYTES).decode("utf-8", "replace")
        except Exception:
            body = ""
        final = exc.geturl() or url
        verdict, reason = classify(exc.code, final, body, url)
        return verdict, exc.code, reason, cs.host_of(final)
    except urllib.error.URLError as exc:
        text = str(getattr(exc, "reason", exc)).lower()
        if "refused" in text or "reset" in text or "unreachable" in text:
            return "refused", 0, "refused", ""
        if "timed out" in text or "timeout" in text:
            return "timeout", 0, "timeout", ""
        return "unverified", 0, "network", ""
    except Exception:
        return "timeout", 0, "timeout", ""


def find_discrepancies(services, catalog):
    """The actionable direction only: the catalog says reachable, Belarus says otherwise.

    The reverse case is deliberately NOT reported. A service marked "blocked" often
    still serves its landing page -- the block happens at sign-in or inside the app --
    so "the page opened" would produce a dozen false "maybe unblocked" hints. Only a
    refusal where the catalog promises access is worth a human's time.
    """
    out = []
    for name in sorted(services):
        record = services[name] or {}
        access = (catalog.get(name) or {}).get("access_level", "")
        verdict = record.get("verdict", "")
        if access not in ("available", "limited", "via_aggregator") or not verdict:
            continue
        if verdict in BLOCK_VERDICTS:
            out.append({
                "name": name,
                "catalog": access,
                "geo": verdict,
                "hint_ru": "В каталоге сервис доступен, а из Беларуси не пускает — вероятно, нужен access_level \"blocked\".",
                "hint_en": "The catalog lists this service as reachable, but Belarus is refused — it probably needs access_level \"blocked\".",
            })
        elif verdict in SOFT_VERDICTS:
            out.append({
                "name": name,
                "catalog": access,
                "geo": verdict,
                "hint_ru": "Из Беларуси приходит отказ 403 — возможно, гео-блок или защита от ботов. Проверьте вход вручную.",
                "hint_en": "Belarus gets a 403 — either a geo-block or a bot challenge. Check the sign-in by hand.",
            })
    return out


def push():
    """Commit and push geo-checks.json. Never force-pushes, never touches other files."""
    def run(*cmd):
        return subprocess.run(cmd, capture_output=True, text=True)

    run("git", "add", GEO_FILE)
    status = run("git", "status", "--porcelain", GEO_FILE)
    if not (status.stdout or "").strip():
        print("geo-checks.json unchanged; nothing to push")
        return 0
    stamp = datetime.date.today().isoformat()
    commit = run("git", "commit", "-m", f"chore(geo): refresh geo checks ({stamp})")
    if commit.returncode != 0:
        print((commit.stderr or commit.stdout).strip())
        return 1
    run("git", "pull", "--rebase", "--autostash", "origin", "main")
    sent = run("git", "push", "origin", "main")
    if sent.returncode != 0:
        print((sent.stderr or sent.stdout).strip())
        return 1
    print("pushed geo-checks.json")
    return 0


# ---------------------------------------------------------------------- main
def main():
    parser = argparse.ArgumentParser(
        description="Check which catalogued services open from a Belarusian connection.")
    parser.add_argument("--write", action="store_true", help="write geo-checks.json")
    parser.add_argument("--push", action="store_true",
                        help="write, commit and push geo-checks.json")
    parser.add_argument("--all", action="store_true",
                        help="probe every service, not only blocked and limited ones")
    parser.add_argument("--limit", type=int, default=0, help="probe at most N services")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                        help="per-request timeout in seconds")
    parser.add_argument("--skip-vantage-check", action="store_true",
                        help="do not verify that this connection is in Belarus (testing only)")
    args = parser.parse_args()

    now = datetime.datetime.now(datetime.timezone.utc)
    today = now.date().isoformat()

    here = vantage()
    country = (here.get("country") or "").upper()
    if not args.skip_vantage_check and country != "BY":
        print(f"refusing to run: this connection is in {country or 'an unknown country'}, not BY.")
        print("A geo probe from anywhere else would repeat the US-runner mistake.")
        print("Turn the VPN off, or pass --skip-vantage-check for a test run.")
        return 2
    if here:
        print(f"vantage: {country or '?'} {here.get('city') or ''} ({here.get('provider') or '?'})")

    catalog = load_catalog()
    targets = [(name, info.get("url", "")) for name, info in catalog.items()
               if info.get("url") and (args.all or info.get("access_level") in RISKY_LEVELS)]
    targets.sort()
    if args.limit:
        targets = targets[: args.limit]
    if not targets:
        print("nothing to probe: no catalogued service matched the filter")
        return 0

    previous = {}
    if os.path.exists(GEO_FILE):
        try:
            with open(GEO_FILE, encoding="utf-8") as handle:
                previous = (json.load(handle) or {}).get("services") or {}
        except (OSError, ValueError):
            previous = {}

    print(f"AI Compass - geo probe ({len(targets)} services, {MAX_WORKERS} workers)")
    print("This run writes geo-checks.json only; access_level stays hand-curated.")

    results = {}

    def run_one(pair):
        name, url = pair
        verdict, code, reason, final_host = probe(url, args.timeout)
        prev = previous.get(name) or {}
        confirmations = 1
        if prev.get("verdict") == verdict:
            confirmations = int(prev.get("confirmations") or 0) + 1
        status = "suspected"
        if verdict in BLOCK_VERDICTS and confirmations >= CONFIRM_THRESHOLD:
            status = "confirmed"
        return name, {
            "verdict": verdict,
            "status": status,
            "http": code,
            "reason": reason,
            "url": url,
            "final_host": final_host,
            "catalog_access": (catalog.get(name) or {}).get("access_level", ""),
            "confirmations": confirmations,
            "note_ru": NOTE_RU.get(verdict, ""),
            "note_en": NOTE_EN.get(verdict, ""),
            "checked_at": today,
        }

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for name, record in pool.map(run_one, targets):
            results[name] = record

    summary = {}
    for record in results.values():
        summary[record["verdict"]] = summary.get(record["verdict"], 0) + 1
    for verdict in VERDICTS:
        if summary.get(verdict):
            print(f"  {verdict:14s} {summary[verdict]}")
    for name in sorted(results):
        record = results[name]
        if record["verdict"] != "open":
            print(f"  {record['verdict']:14s} {name} ({record['reason']})")

    discrepancies = find_discrepancies(results, catalog)
    if discrepancies:
        print(f"\nreview queue ({len(discrepancies)}):")
        for item in discrepancies:
            print(f"  {item['name']}: catalog says {item['catalog']}, from here {item['geo']}")

    if not (args.write or args.push):
        print("\ndry run: nothing written (pass --write to save geo-checks.json)")
        return 0

    payload = {
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "checked_at": today,
        "generated_by": "geo_probe.py",
        "note": GEO_NOTE,
        "vantage": here,
        "threshold": CONFIRM_THRESHOLD,
        "summary": summary,
        "services": results,
        "discrepancies": discrepancies,
    }
    with open(GEO_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"\nwrote {GEO_FILE} ({len(results)} services, {len(discrepancies)} review items)")

    if args.push:
        return push()
    return 0


if __name__ == "__main__":
    sys.exit(main())
