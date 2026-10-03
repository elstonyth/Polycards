# Growth daily hits: a 12 a.m. Hermes cron drop

**Date:** 2026-10-04 · **Status:** approved in chat by the operator (option B, the AI writes the post) · **Builds on:** `2026-09-29-desk-reports-design.md`

## Problem

The operator wants the Growth desk to receive, every night at 12 a.m. Malaysia time, yesterday's biggest pulls and withdrawals:

- a posting image of the top 10 single pulls, ready for social media;
- the Telegram pull card for each of those pulls, the same image the Telegram channel posts;
- the full details of those customers and of every customer who withdrew, with the amounts, in an Excel file;
- all of it set up as a Hermes cron job.

## Decisions (operator, 2026-10-04)

| Question             | Decision                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who writes the post  | The Growth bot (AI) in a Hermes cron job at `0 0 * * *` (the profile's zone is Asia/Kuala_Lumpur), delivered to the Growth desk. Its cron toolset is locked to the report tools (`platform_toolsets.cron`), so no terminal or file tools.      |
| Customer details     | Full phone number, email, bank (bank, full account number, holder name) for withdrawals, and an account summary (username, join date, VIP level, wallet balance, lifetime deposits and withdrawals).                                           |
| Where the details go | Only inside the Excel file. Never in the message text and never through the AI: a pre-run script fetches the files and gives the AI only the non-personal summary and the file paths.                                                          |
| Top 10               | The 10 most valuable single pulls of the day, ranked by the pulled value the Ranks page uses (`PULLED_VALUE_USD_SQL` × FX), paid packs only (`source = 'pack'`, as on every board). Disabled players are left out, as on every public surface. |

The admin Withdrawals page masks account numbers in lists and reveals them one row at a time. This Excel lists them in full by the operator's choice; the backend logs every fetch (`[reports] growth /reports/growth/daily-report?...`).

## Design

### Backend (`/reports/growth/*`, read-only)

| Route                      | Returns                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET top-pulls?day&limit`  | One Malaysia day (default yesterday): the top pulls (default 10, at most 20) with rank, time, card (name, grade, set, rarity, art), pack, value in RM and the player's public name and handle. No customer id or contact details. MCP tool `top_pulls`.                                                |
| `GET top-pulls-poster?day` | The posting poster, 1080×1350 in the site design: one tile per pull with the slab art, card, value in chase gold and the public name. Drawn by the same ladder layout as the achievements poster. MCP tool `top_pulls_poster`.                                                                         |
| `GET pull-card?pull`       | The Telegram pull card (`renderPullCard`) for one paid pull, priced at its pulled value. No MCP tool.                                                                                                                                                                                                  |
| `GET daily-report?day`     | The Excel: sheet "Top pulls" (the same pulls with full customer details) and sheet "Withdrawals" (every withdrawal requested that day, any status, with bank details and customer details). **Growth key only** (any other desk key is refused), and no MCP tool, so no desk bot can fetch it in chat. |

### Hermes

- Pre-run script `daily_hits.py` (Python, stdlib only) in the Growth profile's `scripts/`. It reads the Growth key from the profile's `.env` and fetches yesterday's top pulls, the 10 pull cards, the poster and the Finance `payments` summary. It saves the files under the profile's `cache/images` (allowed by strict media delivery), and prints a data block with no personal details plus one `MEDIA:` line per file.
- Cron job `growth-daily-hits` at `0 0 * * *` on `polycards-growth`, `--script daily_hits.py`, delivered to the Growth desk. The prompt tells the bot to write the post (the list, the withdrawal summary and an English caption draft) and copy every `MEDIA:` line unchanged.
- Cron job `growth-daily-excel` at `5 0 * * *`, `--script daily_excel.py --no-agent`: posts the staff Excel verbatim, with a staff-only note, five minutes after the post. The Excel never goes through the AI: on the first live run (2026-10-04) the model withheld it on its own judgment, so it now has a job no model can veto.
- Growth config: `platform_toolsets.cron: [polycards_growth]` and `cron.wrap_response: false`.

## Testing

- Unit: the Malaysia-day window, the ladder layout for both posters, and the sheet columns.
- Integration: ranking, day window, limit, paid packs only, disabled players hidden, no personal data in `top-pulls`; JPEGs for the card and the poster; the Excel holds the details and opens only for the Growth key.
- The script's own `--self-test`, then a dry run against production that writes the files without posting.
