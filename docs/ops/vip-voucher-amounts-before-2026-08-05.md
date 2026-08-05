# VIP ladder voucher amounts, before they were zeroed (2026-08-05)

`Migration20260805000000` sets `vip_level.voucher_amount = 0` on all 100 rungs
(operator decision: the surface that redeems vouchers has been suspended since
#294, so a level-up was minting grants nobody could spend). Its `down()` is
deliberately empty — the amounts were operator config, and writing the workbook
figures back would invent numbers the operator had already changed.

So the amounts are written down here instead. This is a record, not a rollback:
restoring any of it is a deliberate re-price, and `saveVoucherRanges`
(`POST /admin/daily-rewards/vouchers`) is the endpoint that would do it.

**Source:** `SELECT level, voucher_amount FROM vip_level ORDER BY level;` against
the local prod clone on 2026-08-05. The 90s band matches the operator's
screenshot of the live Levels tab exactly (L91–L99 = 1,500, L100 = 15,000), and
the figures diverge from `scripts/vip-levels.data.ts` (the Workbook1.xlsx
ladder), which is why the workbook alone was not a sufficient record.

Re-run the same query against production before merging if you want a dump that
is authoritative rather than clone-dated.

| Levels | voucher_amount (RM) |
| --- | --- |
| L1 | 0 |
| L2–L6 | 2 |
| L7–L9 | 5 |
| L10 | 50 |
| L11–L19 | 10 |
| L20 | 300 |
| L21–L29 | 88 |
| L30 | 888 |
| L31–L39 | 120 |
| L40 | 1,200 |
| L41–L59 | 300 |
| L60 | 3,000 |
| L61–L69 | 500 |
| L70 | 5,000 |
| L71–L79 | 800 |
| L80 | 8,000 |
| L81–L89 | 1,200 |
| L90 | 12,000 |
| L91–L99 | 1,500 |
| L100 | 15,000 |

Decade rungs (L10, L20, … L100) pay the large amounts; the levels between them
pay the small band. L90 and L100 are the two that exceeded `MAX_VOUCHER_MYR`
(10,000) and blocked every save on the VIP Levels tab since #247.

**Already-minted grants are untouched.** This migration only stops new ones —
`/store/rewards/claim/[grantId]` stays live and `claimGrant` still credits a
customer who earned one before the cutover.
