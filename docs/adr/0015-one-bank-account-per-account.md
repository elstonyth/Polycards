# One person, one account: one bank account per Polycards account, changed only by support

Owner's policy, 2026-11-03: one person may have only one account. The bank
account is the hard link that enforces it. A Polycards account has one bank account, and a bank
account belongs to one Polycards account. Once saved, the customer cannot remove
it or add another: they contact support, and support removes it from the admin
player page. This reverses the 2026-10-17 decision that switched the rule off
(`PAYOUT_ACCOUNT_SHARING_ALLOWED='*'`, #804), and that env list is gone.

Why now: one person ran 10 accounts onto one Public Bank number, under 10 holder
names, farming the free pack and task rewards and cashing out minutes apart. The
old rule could not have stopped it even when on. It let a number that was only
saved through under a different holder name, it exempted anything saved before
2026-10-14, and a customer could remove an account to swap it.

Three things follow:

- **A shared number is held, not frozen.** Any other live customer who saved or
  was paid to the number blocks the save and refuses the payout, for every account
  on it, including whoever was paid first. Any shared number on the saved list
  holds the whole account, so a second saved number is no way round it. It is
  checked live, so existing
  clusters were covered the moment it shipped, with no bulk write to customers. A
  manual freeze would also stop sell-backs and reward claims, so it stays a
  separate, per-customer decision for support. Packs, top-ups and sell-backs keep
  working during a hold, and the money stays in the wallet.
- **Support lifts a payout hold per customer** (`metadata.bank_share_verified_at`,
  set only through the audited verify route). It never lets a new shared number be
  saved. Paid-out rows are permanent, so without this no
  account on a number that was ever paid could withdraw again. Other accounts on
  the number stay held, and a second account on it cannot be verified while the
  first is. Emptying the list clears the verification, so it never vouches for the
  next number.
- **Lists that already hold several accounts were left alone.** They refuse a new
  one, and support removes the extras. Rewriting 166 customers' lists by script was
  not worth it.
- **Only the saved list holds, not payout history.** An account paid to a shared
  number that no longer has it saved is not held, or support removing a number
  could never free anyone. Support can freeze those by hand.

Accepted: a stranger who saves someone's number first locks the real owner out
until support removes it. Someone whose number another account was already paid to
cannot save it at all, because paid-out rows are permanent, and support has no
override for that today. Wallets keep their narrower rule, because an address has
no holder name and is public on-chain: only a wallet already paid out to counts.
Deleting an account still frees its numbers, because the deletion scrub cuts its
payout rows to the last 4 digits.
