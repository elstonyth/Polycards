import { isDefaultPlayerGroup, isPartnerGroup } from './player-groups';

// What the Create Player modal pre-fills. Generated in the browser so the
// operator sees (and can copy) the credentials before anything is written;
// POST /admin/players validates whatever is finally submitted.

const EMAIL_DOMAIN = 'polycards.gg';
// Lowercase + digits minus the look-alikes (0/o, 1/l): these get read out
// loud and typed by hand. 32 symbols, so a byte modulo it is unbiased.
const EMAIL_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
// ponytail: same alphabet plus uppercase, no symbols — 16 chars is ~90 bits,
// and a symbol-free password survives being pasted into a chat app.
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const pick = (alphabet: string, n: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

/** `partner-xxxxxx@polycards.gg` — the prefix says what the account is for in
 *  the Players list; the operator can overtype it. */
export const generatePlayerEmail = (prefix = 'partner'): string =>
  `${prefix}-${pick(EMAIL_ALPHABET, 6)}@${EMAIL_DOMAIN}`;

export const generatePlayerPassword = (): string => pick(PASSWORD_ALPHABET, 16);

type GroupLike = {
  id: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** The group the modal preselects: the first partner group (that is what
 *  operator-minted accounts are for), else DEFAULT, else nothing. */
export const defaultGroupForNewPlayer = (
  groups: readonly GroupLike[],
): string =>
  (groups.find(isPartnerGroup) ?? groups.find(isDefaultPlayerGroup))?.id ?? '';
