"""Growth desk 12 a.m. drop: the pre-run script of the polycards-growth cron.

Spec: docs/superpowers/specs/2026-10-04-growth-daily-hits-design.md.

Hermes runs this before the Growth bot each night and puts its stdout into
the bot's prompt. It fetches yesterday's (Malaysia time) top paid pulls from
the backend's read-only reports, the Telegram pull card for each, the posting
poster, the staff Excel and the withdrawal summary, and saves the files in
this profile's Hermes cache, the only place strict media delivery uploads
from. It prints a data block and one MEDIA: line per file.

It never prints a phone number, email or bank detail: those stay inside the
Excel, so they never reach the AI model. Python standard library only.

    python daily_hits.py              # the nightly run
    python daily_hits.py --self-test  # offline checks, no network
"""

import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROFILE = Path(__file__).resolve().parent.parent  # profiles/polycards-growth
BASE_URL = os.environ.get("DAILY_HITS_BASE_URL", "https://admin.polycards.gg")
MYT = datetime.timezone(datetime.timedelta(hours=8))
TIMEOUT = 90  # a poster fetches ten slabs server-side


def yesterday_myt(now=None):
    """The Malaysia day before `now`: the day a 12 a.m. drop reports on."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return (now.astimezone(MYT) - datetime.timedelta(days=1)).date().isoformat()


def day_window(day):
    """[from, to) of one Malaysia day, as UTC ISO strings."""
    start = datetime.datetime.fromisoformat(day).replace(tzinfo=MYT)
    end = start + datetime.timedelta(days=1)
    iso = lambda t: t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return iso(start), iso(end)


def rm(value):
    return f"RM {value:,.2f}"


# The tiers a Telegram pull card is drawn for (the operator's call,
# 2026-10-05): Legendary and above, in the site's order Immortal > Legendary
# > Mythical > Rare > Uncommon > Common. The poster still shows the top 10.
CARD_TIERS = ("Immortal", "Legendary")


def gets_pull_card(pull):
    """Whether a top pull gets its own Telegram pull card."""
    return pull["card"].get("rarity") in CARD_TIERS


def withdrawal_line(by_status):
    """'settled 5 (RM 1,234.00) · held 1 (RM 1,925.11) · ...' for the statuses
    the payments report returns, busiest first; 'none' when empty."""
    parts = [
        (status, row.get("count", 0), row.get("requested", 0))
        for status, row in (by_status or {}).items()
        if row.get("count", 0)
    ]
    parts.sort(key=lambda p: -p[1])
    return " · ".join(f"{s} {n} ({rm(a)})" for s, n, a in parts) or "none"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # The key travels in a header that a redirect would replay elsewhere.
    def redirect_request(self, *args, **kwargs):
        return None


def _key():
    for line in (PROFILE / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("REPORT_KEY_GROWTH="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("REPORT_KEY_GROWTH is not set in the growth profile's .env.")


def _get(path, params, key, tries=3):
    """One report, retried on a timeout or a 5xx (an edge 504 while a card
    renders is transient); a 4xx is final."""
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    request = urllib.request.Request(
        f"{BASE_URL}/reports/{path}?{query}",
        headers={"x-report-key": key, "accept": "*/*", "user-agent": "polycards-daily-hits"},
    )
    opener = urllib.request.build_opener(_NoRedirect)
    for attempt in range(1, tries + 1):
        try:
            with opener.open(request, timeout=TIMEOUT) as response:
                return response.read()
        except urllib.error.HTTPError as err:
            if err.code < 500 or attempt == tries:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries:
                raise
        time.sleep(5 * attempt)


def _save(folder, name, data):
    path = PROFILE / "cache" / folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def main():
    day = yesterday_myt()
    key = _key()
    notes, files = [], []

    top = json.loads(_get("growth/top-pulls", {"day": day}, key))
    pulls = top.get("pulls", [])

    if pulls:
        try:
            files.append(_save("images", f"hits-{day}-poster.jpg",
                               _get("growth/top-pulls-poster", {"day": day}, key)))
        except OSError as err:  # URLError and timeouts
            notes.append(f"The posting poster could not be drawn ({err}).")
        for pull in filter(gets_pull_card, pulls):
            try:
                files.append(_save("images", f"hits-{day}-{pull['rank']:02d}.jpg",
                                   _get("growth/pull-card", {"pull": pull["pull_id"]}, key)))
            except OSError as err:  # URLError and timeouts
                notes.append(f"The Telegram card for #{pull['rank']} could not be drawn ({err}).")

    # The staff Excel is NOT fetched here: the model would decide for itself
    # whether to attach customers' bank details, and on 2026-10-04 it chose
    # not to. daily_excel.py posts it from its own no-AI job instead.

    start, end = day_window(day)
    try:
        payments = json.loads(_get("finance/payments", {"from": start, "to": end, "group": "all"}, key))
        withdrawals = withdrawal_line(payments.get("withdrawals", {}).get("by_status"))
    except OSError as err:  # URLError and timeouts
        withdrawals = "unavailable"
        notes.append(f"The withdrawal summary could not be read ({err}).")

    print(f"DAILY TOP HITS DATA for {day} (Malaysia time, 00:00 to 24:00)")
    print("TOP PULLS (paid packs, ranked by pulled value; names are public display names):")
    if not pulls:
        print("none: no paid pulls that day")
    for pull in pulls:
        card = pull["card"]
        title = f"{card['name']} · {card['grade']}" if card["grade"] else card["name"]
        pack = pull["pack"]["title"] or pull["pack"]["slug"]
        print(f"{pull['rank']}. {title} | {rm(pull['value_myr'])} | {card['rarity']} | {pack} | {pull['player']['name']}")
    carded = [p["rank"] for p in pulls if gets_pull_card(p)]
    print(
        "TELEGRAM PULL CARDS (Legendary and Immortal pulls only): "
        + (", ".join(f"#{r}" for r in carded) if carded else "none: no Legendary or Immortal pull in the top 10")
    )
    print(f"WITHDRAWALS REQUESTED THAT DAY (status count (RM requested)): {withdrawals}")
    print("STAFF EXCEL: posted separately at 00:05 by its own job (full customer details: phone, email, bank). Staff only, never to be posted publicly.")
    for note in notes:
        print(f"PROBLEM: {note}")
    print("FILES (copy every MEDIA line below into the post, unchanged):")
    for path in files:
        print(f"MEDIA:{path}")


def day_label(day):
    """'2026-10-03' as '3 Oct 2026'."""
    d = datetime.date.fromisoformat(day)
    return f"{d.day} {d.strftime('%b %Y')}"


def excel_message(day, path):
    """What the no-AI Excel job posts: a short staff-only note and the file."""
    return (
        f"**Staff Excel · Daily Top Hits {day_label(day)}**\n"
        "DEFAULT-group players only: full customer details for every "
        "Immortal, Legendary and Mythical pull, and every withdrawal "
        "(phone, email, bank). "
        "Staff only: never post this file or its contents publicly.\n"
        f"MEDIA:{path}"
    )


def excel_main():
    """The 00:05 no-AI job: fetch yesterday's staff Excel and print the post.
    A failure exits non-zero, which Hermes reports in the channel."""
    day = yesterday_myt()
    path = _save("documents", f"polycards-daily-{day}.xlsx",
                 _get("growth/daily-report", {"day": day}, _key()))
    print(excel_message(day, path))


def _self_test():
    utc = datetime.timezone.utc
    assert day_label("2026-10-03") == "3 Oct 2026"
    assert excel_message("2026-10-03", "C:\\x.xlsx").endswith("\nMEDIA:C:\\x.xlsx")
    assert "Staff only" in excel_message("2026-10-03", "C:\\x.xlsx")
    assert "Immortal, Legendary and Mythical" in excel_message("2026-10-03", "C:\\x.xlsx")
    assert yesterday_myt(datetime.datetime(2026, 10, 4, 16, 30, tzinfo=utc)) == "2026-10-04"
    assert yesterday_myt(datetime.datetime(2026, 10, 4, 15, 59, tzinfo=utc)) == "2026-10-03"
    assert day_window("2026-10-03") == ("2026-10-02T16:00:00.000Z", "2026-10-03T16:00:00.000Z")
    assert rm(1925.1) == "RM 1,925.10"
    assert withdrawal_line({
        "settled": {"count": 5, "requested": 1234},
        "held": {"count": 1, "requested": 1925.11},
        "pending": {"count": 0, "requested": 0},
    }) == "settled 5 (RM 1,234.00) · held 1 (RM 1,925.11)"
    assert withdrawal_line({}) == "none"
    tiers = ["Immortal", "Legendary", "Mythical", "Rare", "Uncommon", "Common", None]
    assert [gets_pull_card({"card": {"rarity": t}}) for t in tiers] == [True, True, False, False, False, False, False]
    print("self-test ok")


if __name__ == "__main__":
    # Hermes reads a cron script's stdout as UTF-8 on Windows, whatever the
    # console's code page; without this "·" arrives as a replacement mark.
    sys.stdout.reconfigure(encoding="utf-8")
    if "--self-test" in sys.argv:
        _self_test()
    else:
        try:
            main()
        except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
            print(f"DAILY TOP HITS FAILED: {err}")
            sys.exit(1)
