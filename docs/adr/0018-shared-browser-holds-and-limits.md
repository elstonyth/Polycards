# A shared browser holds a withdrawal for review and limits the welcome pack

Supersedes in part ADR 0016 ("never a block"), owner 2026-11-17.

The A1 farm review found confirmed farm groups that shared a browser id. They took a
welcome pack on every account and cashed out. The browser id stays a cookie that a
farmer can clear, so it is never a gate at signup. Where it does match, it now acts in
two places.

- **One welcome pack per person or household.** `claimFreePack` refuses an account
  when another account that shares a browser id with it has already claimed one (any
  account not deleted: banned and disabled ones count).
  The ids checked are the ones recorded for the account plus the one on the open
  request (`vouchedVisitorDevice`). A lock per browser id makes two accounts claiming
  at once take turns. The refusal says "one per person or household" and never names
  the browser, so it teaches nothing to work around. No browser id means no match.
  A confirmed household does not unlock a second pack.
- **A withdrawal from a later account on a shared browser waits for review.** If an
  earlier account (not deleted; banned and disabled ones count) shares the browser and
  support has not confirmed the pair, the
  withdraw route sets `reviewHold`, and the row is written `held` with
  `hold_reason = 'shared_device'`, whatever its amount. The first account on a
  browser is never held. A real player group (partners, house) is exempt, as it is
  from the no-top-up gate. The customer sees the same "awaiting approval" as for a
  large amount. The reason is for staff only.
- **The reviewer sees everything on one screen.** `GET
  /admin/payments/withdrawals/:id/links` returns:
  - linked accounts by browser, network and referral, with their money;
  - every bank saved or paid to, and who else used it;
  - same-name accounts.
  It needs `customer_bank_account:read`, and each open is an audited reveal.
  Approve can confirm the pair as one household (`verify_device_peers`). That writes
  `metadata.device_share_verified`, audited, so the account is not held for those
  accounts again. Only the approve route writes it, and the metadata guard refuses it
  everywhere else.

Both rules see only the browser ids still kept, the 180 days after an account was last
seen (ADR 0016), and none for an account whose cookie was cleared.

Holds, not blocks: a block would teach farms to clear cookies and rotate networks, and
would lose the overlap that exposed them. A hold keeps the signal and lets a family
through after one check.

Not done (owner 2026-11-17): a prize allowance tied to top-ups, a hold on coin-flip
wins, and referral commission on deposit-funded spend only.
