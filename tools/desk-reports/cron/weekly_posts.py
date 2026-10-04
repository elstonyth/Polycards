"""Growth desk Monday 9 a.m. posts: the pre-run script of a polycards-growth cron.

Spec: docs/superpowers/specs/2026-10-04-growth-weekly-posts-design.md.

Hermes runs this before the Growth bot every Monday and puts its stdout into
the bot's prompt. It fetches three posting posters from the backend's
read-only reports (last week's Weekly Challenge result, every stage of the
new week's challenge, the week's tasks) and the data behind them, saves the
images in this profile's Hermes cache (the only place strict media delivery
uploads from), and prints a data block and one MEDIA: line per image.

Public display names only: no customer ids or contact details ever reach it.
The fetching helpers live in daily_hits.py, beside it in scripts/. Python
standard library only.

    python weekly_posts.py              # the Monday run
    python weekly_posts.py --self-test  # offline checks, no network
"""

import datetime
import json
import sys
import urllib.error

from daily_hits import MYT, _get, _key, _save, rm

WEEK = datetime.timedelta(days=7)


def _iso(text):
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))


def week_words(start_iso, end_iso):
    """'5 – 11 Oct 2026' for a challenge week [start, end) in Malaysia time."""
    start = _iso(start_iso).astimezone(MYT)
    last = (_iso(end_iso) - datetime.timedelta(seconds=1)).astimezone(MYT)
    if start.month == last.month:
        return f"{start.day} – {last.day} {last.strftime('%b %Y')}"
    return f"{start.day} {start.strftime('%b')} – {last.day} {last.strftime('%b %Y')}"


def settled_last_week(results_start_iso, current_start_iso):
    """Whether the settled week IS the one before the running week: the
    hourly settlement may not have run yet."""
    return _iso(results_start_iso) == _iso(current_start_iso) - WEEK


def winner_line(w):
    """'1. squirtle | pulled RM 139,728.00 | won Pikachu · PSA 10 + 2 more
    cards and RM 150.00 credits (worth RM 12,400.00 today)'."""
    cards = w.get("cards") or []
    count = sum(c["qty"] for c in cards)
    parts = []
    if cards:
        more = count - 1
        parts.append(cards[0]["name"] + (f" + {more} more card{'s' if more != 1 else ''}" if more else ""))
    if w.get("credits"):
        parts.append(f"{rm(w['credits'])} credits")
    won = " and ".join(parts) or "nothing"
    pulled = rm(w["pulled_value_myr"]) if w.get("pulled_value_myr") is not None else "n/a"
    return f"{w['rank']}. {w['name']} | pulled {pulled} | won {won} (worth {rm(w['prize_value_myr'])} today)"


def stage_line(s):
    """'Stage 1, unlocks at RM 300,000.00: #1 Mewtwo #3, #2 ..., #4-#10 RM 1,800.00 to RM 80.00 credits'."""
    top, credits = [], []
    for p in s["prizes"]:
        if p["rank"] <= 3:
            top.append(f"#{p['rank']} {p['card'] or rm(p['credits']) + ' credits'}")
        elif p["credits"]:
            credits.append(p["credits"])
    rest = ""
    if credits:
        rest = f"; #4-#10 {rm(max(credits))} to {rm(min(credits))} credits"
    state = "unlocked" if s.get("unlocked") else f"unlocks at {rm(s['threshold_myr'])}"
    return f"Stage {s['stage']} ({state}): {', '.join(top)}{rest}"


def task_line(t):
    value = f" (worth {rm(t['value_myr'])})" if t.get("value_myr") else ""
    return f"- {t['requirement']} -> {t['prize']}{value}"


def _why(err):
    """The backend's own sentence for a refusal, else the error itself."""
    if isinstance(err, urllib.error.HTTPError):
        try:
            return json.loads(err.read()).get("message") or str(err)
        except ValueError:
            return str(err)
    return str(err)


def main():
    key = _key()
    stamp = datetime.datetime.now(MYT).strftime("%Y-%m-%d")
    notes, files = [], []

    current = json.loads(_get("growth/challenge", {}, key))
    week = current.get("week") or {}

    try:
        results = json.loads(_get("growth/challenge-results", {}, key))
    except OSError as err:  # HTTPError (a 404 before any settlement), URLError, timeouts
        results = None
        notes.append(f"Last week's results could not be read: {_why(err)}")

    print(f"WEEKLY POSTS DATA for {week_words(week['start'], week['end'])} (Malaysia time)")

    print("1) LAST WEEK'S CHALLENGE RESULT (prizes exactly as settlement paid them; names are public display names):")
    if results and not settled_last_week(results["week"]["start"], week["start"]):
        notes.append(
            "Last week has not been settled yet (the latest settled week is "
            f"{week_words(results['week']['start'], results['week']['end'])}), so the results poster is left out."
        )
        results = None
    if results:
        unlocked = ", ".join(str(n) for n in results["unlocked_stages"]) or "none"
        pool = rm(results["pool_myr"]) if results.get("pool_myr") is not None else "n/a"
        print(f"Week {week_words(results['week']['start'], results['week']['end'])} · pool {pool} · stages unlocked: {unlocked}")
        for w in results["winners"]:
            print(winner_line(w))
        if results.get("hidden_winners"):
            print(f"({results['hidden_winners']} winner(s) left out: disabled account; the others keep their paid rank)")
        try:
            files.append(_save("images", f"weekly-{stamp}-1-results.jpg", _get("growth/challenge-results-poster", {}, key)))
        except OSError as err:
            notes.append(f"The results poster could not be drawn: {_why(err)}")
    else:
        print("none")

    print(f"2) THIS WEEK'S CHALLENGE ({week_words(week['start'], week['end'])}; every unlocked stage's prizes stack):")
    stages = current.get("stages") or []
    for s in stages:
        print(stage_line(s))
    if stages:
        try:
            files.append(_save("images", f"weekly-{stamp}-2-stages.jpg", _get("growth/challenge-stages-poster", {}, key)))
        except OSError as err:
            notes.append(f"The challenge stages poster could not be drawn: {_why(err)}")
    else:
        print("none: the challenge has no stages set up")

    print("3) THIS WEEK'S TASKS (as the /task page shows them):")
    try:
        weekly = json.loads(_get("growth/tasks", {}, key)).get("weekly", [])
    except OSError as err:
        weekly = []
        notes.append(f"The tasks could not be read: {_why(err)}")
    for t in weekly:
        print(task_line(t))
    if weekly:
        try:
            files.append(_save("images", f"weekly-{stamp}-3-tasks.jpg", _get("growth/tasks-poster", {}, key)))
        except OSError as err:
            notes.append(f"The tasks poster could not be drawn: {_why(err)}")
    else:
        print("none: no weekly tasks are live")

    for note in notes:
        print(f"PROBLEM: {note}")
    print("FILES (copy every MEDIA line below into the post, unchanged):")
    for path in files:
        print(f"MEDIA:{path}")


def _self_test():
    assert week_words("2026-10-04T16:00:00.000Z", "2026-10-11T16:00:00.000Z") == "5 – 11 Oct 2026"
    assert week_words("2026-09-27T16:00:00.000Z", "2026-10-04T16:00:00.000Z") == "28 Sep – 4 Oct 2026"
    assert settled_last_week("2026-09-27T16:00:00.000Z", "2026-10-04T16:00:00.000Z")
    assert not settled_last_week("2026-09-20T16:00:00.000Z", "2026-10-04T16:00:00.000Z")
    assert winner_line({
        "rank": 1, "name": "squirtle", "pulled_value_myr": 139728, "credits": 150,
        "cards": [{"name": "Pikachu · PSA 10", "qty": 2}, {"name": "Lugia GX", "qty": 1}],
        "prize_value_myr": 12400,
    }) == "1. squirtle | pulled RM 139,728.00 | won Pikachu · PSA 10 + 2 more cards and RM 150.00 credits (worth RM 12,400.00 today)"
    assert winner_line({
        "rank": 4, "name": "ATYH", "pulled_value_myr": None, "credits": 2000, "cards": [], "prize_value_myr": 2000,
    }) == "4. ATYH | pulled n/a | won RM 2,000.00 credits (worth RM 2,000.00 today)"
    assert stage_line({
        "stage": 1, "threshold_myr": 300000, "unlocked": False,
        "prizes": [
            {"rank": 1, "card": "Mewtwo #3", "credits": 0},
            {"rank": 3, "card": None, "credits": 600},
            {"rank": 4, "card": None, "credits": 1800},
            {"rank": 10, "card": None, "credits": 80},
        ],
    }) == "Stage 1 (unlocks at RM 300,000.00): #1 Mewtwo #3, #3 RM 600.00 credits; #4-#10 RM 1,800.00 to RM 80.00 credits"
    assert task_line({"requirement": "Rip 10 × Bronze Pack this week", "prize": "Free rip · Bronze Pack", "value_myr": 300}) == (
        "- Rip 10 × Bronze Pack this week -> Free rip · Bronze Pack (worth RM 300.00)"
    )
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
            print(f"WEEKLY POSTS FAILED: {err}")
            sys.exit(1)
