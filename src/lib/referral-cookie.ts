/**
 * Cookie that stashes an invite sponsor handle for a guest until they sign up.
 * Written on /invite/<handle> (InviteClient) for guests; claimed exactly once on
 * the first authenticated account landing (ReferralCookieClaim), then cleared.
 * Shared const so the writer and reader can't drift on the name. ~30-day, path=/.
 */
export const REF_COOKIE = 'pokenic_ref';
