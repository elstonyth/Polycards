# Growth weekly posts: a Monday 9 a.m. Hermes cron drop

**Date:** 2026-10-04 · **Status:** approved in chat by the operator · **Builds on:** `2026-10-04-growth-daily-hits-design.md`, `2026-09-29-desk-reports-design.md`

## Problem

Every Monday the operator wants three posting images in the Growth desk, ready for social media:

1. last week's Weekly Pulled Value Challenge result: the winners, their prizes and the values;
2. the new week's challenge prizes, stage 1 to the last stage;
3. the tasks of the week, such as the check-in rewards, "rip 10 Bronze, get 1 Bronze free" and "rip 1 Silver, get a 30th free".

## Decisions (operator, 2026-10-04)

| Question             | Decision                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| Value on the results | Both: the pulled value that won each rank, and the RM value of the prize won. |
| Winners shown        | The top 3, each with their best prize card's art. Ranks 4 to 10 as a list.    |
| When                 | Every Monday at 09:00 Malaysia time (`0 9 * * 1`), in the Growth desk.        |
| Captions             | The Growth bot writes a draft caption for each image, as in the daily job.    |

## Design

### Backend (`/reports/growth/*`, read-only, any desk key)

| Route                                            | Returns                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET challenge-results`                          | The most recently settled week. Includes its dates, pool and unlocked stages. Each paid winner has the paid rank, public name and handle, pulled value for that week, the cards and credits **actually paid** (settlement's `challenge_payout` rows), and the prize value. MCP tool `challenge_results`. |
| `GET challenge-results-poster`                   | The results as a tall portrait poster. MCP tool `challenge_results_poster`.                                                                                                                                                                                                                              |
| `GET challenge-stages-poster?week=current\|next` | Every stage of the running (or queued) challenge on one tall portrait poster. MCP tool `challenge_stages_poster`.                                                                                                                                                                                        |
| `GET tasks-poster`                               | The live weekly tasks, 1080×1350. MCP tool `tasks_poster`.                                                                                                                                                                                                                                               |

Data rules:

- **Results.**
  - Prizes come from the settlement snapshot, never recomputed, so the poster cannot announce a prize nobody was paid.
  - The pulled value is `challengeWeekVolumeFor` on that week: the anchor settlement ranked by, at today's exchange rate.
  - The prize value is the credits plus each card's display market price today (the price `/task` shows) × the quantity.
  - Names are the public display names (`publicProfileFields`).
  - An administratively disabled winner is left out, as on every public surface. The remaining rows keep their paid rank, and staff are told through `x-poster-hidden`.
  - Never a customer id, email or phone.
- **Stages.** From the same builder as the Ranks page (`buildChallengeView`), or from the admin queue for `week=next` (`nextQueuedChallenge`). Each stage shows its threshold, its #1–#3 prizes (card art, or credits) and a summary of ranks 4–10.
- **Tasks.** From `taskCatalogue`, the `/task` page read as nobody. Check-in tiers (`checkin_days`) are grouped into one Daily check-in strip. Every other weekly task gets a full-width tile: the requirement, the prize and what `/task` says it is worth.

### Posters

The three posters use the existing poster language: ink stage, charcoal panels, Nekst display type, Geist body type, chase gold for prizes and values, the official logo, and the grey address pill. Text is SVG rendered by sharp against the bundled fonts, so previews are judged from a Linux render.

### Hermes

- Pre-run script `weekly_posts.py` (Python, stdlib only) in the Growth profile's `scripts/`.
  - It fetches the three posters and the three JSON reports, and saves the images under `cache/images`.
  - It prints a data block with no personal details plus one `MEDIA:` line per image.
  - A poster that cannot be drawn becomes a `PROBLEM:` line; the rest still post.
- Cron job `growth-weekly-posts` at `0 9 * * 1` on `polycards-growth`, `--script weekly_posts.py`, delivered to the Growth desk.
  - The prompt asks for one post with a short heading and a draft English caption per image, then every `MEDIA:` line unchanged.
  - It uses the profile's existing locked cron toolset.

## Testing

- Unit:
  - results shaping (grouping, best card, prize value, hidden winners);
  - the stage summary (podium, ranks 4–10 range);
  - task grouping and wording;
  - each poster composes a JPEG of the expected width.
- Integration:
  - results from seeded payouts, pulls and customers, with disabled winners left out and no personal data;
  - the 404 before any settlement;
  - the stages poster for current and next;
  - the tasks poster.
- MCP tool tests, the script's `--self-test`, then Linux renders from production data for the operator's review before the job is switched on.
