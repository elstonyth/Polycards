# Card pricing checks

Policy confirmed by the operator on 2026-10-16 after Mewtwo ex #157 remained
at USD 875 while its linked ungraded PriceCharting price had fallen to USD 47.50.
The old 5× guard rejected the correction indefinitely.

- Normal, valid source prices continue to refresh daily.
- A move greater than 5× in either direction becomes a pending quote. It does
  not immediately change the card value or price history.
- A later valid quote, at least 24 hours after the first observation and within
  10% of that first quote, confirms the move. The latest quote is applied.
- Confirmation is tied to the same source product, grade, and stored baseline.
  A changed link or baseline, an inconsistent quote, or an unsuccessful source
  check cannot confirm an old pending quote.
- Missing, zero, non-finite, mismatched-source, and above-cap prices remain
  failures. The USD 100,000 absolute ceiling remains in force.
- Pending quotes, source failures, unlinked cards, and stale checks appear in
  the admin attention queue and Cards pricing filter. Failed reads must not be
  presented as an all-clear result.
- An operator can correct a verified value through the existing card editor.
  A price or source-link edit clears the obsolete pending confirmation state.

The daily job runs at 03:00 UTC (11:00 Malaysia time), throttled to at most one
PriceCharting request per second. Two checks means two observations separated
by time, not two immediate retries of the same cached response.

`GET /admin/pricing/health` is the operational check. A successful HTTP response
alone is insufficient: review its card issues and FX age. A source ID removed
or replaced upstream needs an identity-verified link repair; never substitute
a similarly named card or another grade automatically.

The policy prevents indefinitely discarded, stable large moves. It cannot
guarantee that an upstream valuation is correct. Source identity and grade
validation, the absolute cap, and visible unresolved issues remain necessary.
