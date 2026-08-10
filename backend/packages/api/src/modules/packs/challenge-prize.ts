/**
 * Weekly-challenge prizes are minted as pulls against a synthetic pack id
 * (`challenge-<week start>`) — there is no real Pack row to point at. That id is
 * also the ONLY marker distinguishing a challenge prize from any other reward
 * pull once it is sitting in a customer's vault, so the convention lives here
 * rather than being spelled inline at the mint site and re-parsed by readers.
 *
 * Why it matters beyond bookkeeping: a challenge prize wears the challenge's
 * own prism frame everywhere it appears — the stage grid, the card page opened
 * from it, and the vault — instead of the card's pack tier. The storefront must
 * be TOLD that, not left to sniff an id prefix.
 */
export const CHALLENGE_PACK_PREFIX = 'challenge-';

/** Synthetic pack id for the week's prize pulls. */
export const challengePackId = (weekStartIso: string): string =>
  `${CHALLENGE_PACK_PREFIX}${weekStartIso.slice(0, 10)}`;

/** Was this pull minted as a weekly-challenge prize? */
export const isChallengePrizePack = (packId: string | null | undefined) =>
  typeof packId === 'string' && packId.startsWith(CHALLENGE_PACK_PREFIX);
