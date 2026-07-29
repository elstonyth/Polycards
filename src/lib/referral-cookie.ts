/**
 * Cookie that stashes an invite sponsor handle for a guest until they sign up.
 * SUSPENDED 2026-07-29 — nothing writes or claims this any more: /invite was
 * deleted and ReferralCookieClaim was unmounted from the account layout
 * (docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md).
 * REVERT NOTE: cookies set before the suspension live ~30 days, so restoring
 * ReferralCookieClaim inside that window will claim pre-suspension
 * attributions on the first account-tree mount.
 * Was written on /invite/<handle> (InviteClient) for guests; claimed exactly once
 * on the first authenticated account landing (ReferralCookieClaim), then cleared.
 * Shared const so the writer and reader can't drift on the name. ~30-day, path=/.
 */
export const REF_COOKIE = 'polycards_ref';
