"""Growth desk 12:05 a.m. staff Excel: the script of a no-AI Hermes cron job.

Spec: docs/superpowers/specs/2026-10-04-growth-daily-hits-design.md.

Posts yesterday's staff Excel (full customer details for every Legendary
and Immortal pull by DEFAULT-group players, and every withdrawal) to the
Growth desk five minutes after the AI-written Daily Top Hits post. It runs
with --no-agent, so Hermes delivers this script's stdout verbatim: the file
always arrives, and no model decides whether customers' bank details may be
attached (on 2026-10-04 one chose not to). The fetching lives in daily_hits.py, beside it in scripts/.
"""

import sys
import urllib.error

from daily_hits import excel_main

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        excel_main()
    except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
        print(f"The staff Excel could not be built: {err}")
        sys.exit(1)
