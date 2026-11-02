# One person, one account: one bank account per Polycards account, changed only by support

Owner's policy, 2026-11-03: one person may have only one account. The bank account is
the hard link that enforces it. A Polycards account has one bank account, and a bank
account belongs to one Polycards account. Once saved, the customer cannot remove it,
relabel it or add another: they contact support, and support changes it from the admin
player page. This reverses the 2026-10-17 decision that switched the rule off
(`PAYOUT_ACCOUNT_SHARING_ALLOWED='*'`, #804), and that env list is gone.

Why now: one person ran 10 accounts onto one bank number, under 10 holder names,
farming the free pack and task rewards and cashing out minutes apart. The old rule
could not have stopped it even when on. It let a number that was only saved through
under a different holder name, it exempted anything saved before 2026-10-14, and a
customer could remove an account to swap it.

What follows:

- **A shared number is held, not frozen.** Any other live customer who saved or was
  paid to the number refuses the payout, for every account on it, including whoever
  was paid first. Any shared number on the saved list holds the whole account, so a
  second saved number is no way round it. Wallets count too at payout, so accounts
  sharing one address cannot race past the check. It is checked live, so existing
  clusters were covered the moment it shipped, with no bulk write to customers. A
  manual freeze would also stop sell-backs and reward claims, so it stays a separate,
  per-customer decision for support. Packs, top-ups and sell-backs keep working during
  a hold, and the money stays in the wallet.
- **Saving a shared number is refused**, under any holder name. Support's verification
  never changes that for the customer.
- **Support lifts a payout hold per number** (`metadata.bank_share_verified`, set only
  through the audited admin routes). Paid-out rows are permanent, so without this no
  account on a number that was ever paid could withdraw again. Other accounts on the
  number stay held, and a second account on it cannot be verified while the first is.
  Removing an account clears its verification, so it never vouches for the next number.
- **Admin Approve runs the same check** on a held row's own number, so a row held before
  this shipped, or on a number since removed, cannot pay on a click.
- **Support can add a bank account for a player with none.** That is the override for a
  real owner whose number another account holds, whose own save stays refused for good.
  It arrives verified if shared, and starts the usual wait before first use.
- **Lists that already hold several accounts were left alone.** They refuse a new one,
  and support removes the extras. Rewriting 166 customers' lists by script was not worth
  it. The one-shot backfill of saved accounts is retired, since a re-run would put back
  a number support removed.

Accepted, with what covers each:

- A stranger who saves someone's number first locks the real owner out until support
  acts. Wallets are the exception at save: an address is public on-chain and has no
  holder name, so only one already paid out to blocks a save.
- A stranger who saves someone's public wallet address holds that owner's payouts until
  support verifies them. Counting saved wallets at payout is what stops accounts racing
  past the check on one address, and that matters more.
- This matches account numbers, so it cannot see one person with several real
  destinations: a fresh USDT wallet per account, or a Singapore bank number on one
  account and the PayNow mobile linked to it on another.
- A hold stops withdrawals only. Card deliveries still ship, and still cost the zone
  delivery fee.
- Deleting an account frees its numbers, because the deletion scrub cuts its payout rows
  to the last 4 digits. Deletion is operator-run only, so a person decides.
