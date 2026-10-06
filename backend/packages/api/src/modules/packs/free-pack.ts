// Free welcome pack (spec docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md).
// The free pack is a normal Pack in this RESERVED category — hidden from the
// public catalog exactly like 'reward_box', configured with the standard pack
// editor. One active free_welcome pack at a time (admin validation).
export const FREE_WELCOME_CATEGORY = 'free_welcome';

/** Refusal when the account has not finished verifying (spec 2026-10-06):
 *  the welcome pack needs a verified phone AND a real name on file. */
export const FREE_PACK_VERIFICATION_MESSAGE =
  'Verify your phone number and add your real name in Settings to claim the welcome pack.';

/** Refusal when the account's phone number is also on another account (spec
 *  2026-10-06): one phone, one welcome pack. */
export const FREE_PACK_SHARED_PHONE_MESSAGE =
  'This phone number is linked to more than one account, so the welcome pack can’t be claimed. Contact customer service.';

/** User-facing reason shown whenever a locked free pull is refused. */
export const FREE_PULL_LOCKED_MESSAGE =
  'Purchase & open any pack to unlock selling & delivery.';
