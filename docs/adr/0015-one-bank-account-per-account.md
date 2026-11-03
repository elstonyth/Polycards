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
- A real name another account holds is refused at save, ignoring case and the separators
  a name may carry (owner, 2026-11-03, chosen over sending it to staff review). Names
  already on file stay. Real names aren't verified, so one changed letter or a reordered
  name passes, and the refusal tells whoever tries that a name is on the platform,
  though never whose, so one account gets 10 tries an hour. Whoever saves a name first
  holds it, so two real people with one name, or someone whose name a stranger saved,
  go through support, who can set it from the player page.

## Amendment, 2026-11-03: banned numbers, one name, one account per currency

The owner tightened the rule after the farm rings were listed:

- **Banned numbers.** The rings' bank numbers are banned for good in
  `banned_payout_account`, matched on digits without leading zeros at any bank. The
  list is filled on production only, never from the repo. A banned number is refused
  at customer save and at support's add.
- **Banned accounts.** Every listed account is disabled with a `Permanent ban:`
  reason. Login and every session are refused with their own message, with no offer
  of support. Held payouts are denied; pending ones were already with the gateway.
- **One name.** A bank holder name another account already used, saved or paid, is
  refused at save at any bank. Names compare as real names do. Wallets have no holder.
- **Typed twice.** A bank's holder name is typed twice and both must match. A name that
  differs from the bank's is not paid out.
- **One account per currency**, replacing one account in total: one RM bank, one SGD
  bank, one USDT wallet (`bankCurrency`, fixed per bank so a gateway switch never
  moves it). Touch 'n Go has its own slot beside the RM bank (owner, 2026-11-03;
  `savedAccountSlot`). A saved account cannot be changed. Support no longer
  changes one on request either; the admin add and remove tools stay for the
  owner's own fixes.
- **Same name on every bank** (owner, 2026-11-03). A bank or Touch 'n Go saved
  beside another carries a holder name already saved on that account, compared as
  real names are. A wallet has none. Support's add is the way past it for a name
  two banks spell differently, and the refusal says to contact support.
- **Same name, different person** (owner, 2026-11-04). Two real people can share a
  name. Support checks, then clears the name on each account from the player page
  (`bank-accounts/name-clash`); that account's saves then stop counting the other's
  use of it. Per account and per name, audited, and it can be taken back; a third
  account using the name is still refused.
- **Reset.** Every customer's saved list and share stamps were cleared once, after a
  private backup, so everyone saves again under these rules. Payout rows keep their
  own destination, so open payouts were untouched.
- **Rewards.** Task claims need a verified phone and a saved bank, like the welcome
  pack.

Accepted: two real people with one name, or a name a ring account used first, go
through support. A banned account's balance and vault stay locked.
