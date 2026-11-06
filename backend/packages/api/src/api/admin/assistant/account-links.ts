import type PacksModuleService from '../../../modules/packs/service';
import type { Need } from './access';

// account_links (owner, 2026-11-06): other accounts that may be the same
// person, by what is not a bank. ban_reason sees bank numbers and holder names
// only, so it called two accounts of one person "independent" when one of them
// had never saved a bank. These are review signals for support (ADR 0016),
// never proof and never a ban reason. Only booleans and counts leave here: the
// answer goes to an outside model, so no IP, browser id, address or real name.

/** Browser and network matches carry IP addresses: the fence the admin
 *  player page's panel has (SECRET_READS, admin-rbac.ts). */
export const VISITOR_NEED: Need = {
  resource: 'customer_bank_account',
  operation: 'read',
};

export type LinksDb = {
  raw<T>(sql: string, bindings?: readonly unknown[]): Promise<{ rows: T[] }>;
};

// visitorSignalMatches lists at most 10 accounts per network: a network with
// more is a crowd (a mobile carrier), and its list would be cut short.
const MAX_NETWORK_ACCOUNTS = 10;
const MAX_ACCOUNTS = 20;

const SHORT_FORMS: [RegExp, string][] = [
  // "No. 12" and "12" are one house number.
  [/\bno\b/g, ''],
  [/\bjalan\b/g, 'jln'],
  [/\blorong\b/g, 'lrg'],
  [/\btaman\b/g, 'tmn'],
  [/\bkampung\b/g, 'kg'],
  [/\bblock\b/g, 'blk'],
  [/\bavenue\b/g, 'ave'],
  [/\bstreet\b/g, 'st'],
  [/\broad\b/g, 'rd'],
];

/** A saved address as a key two spellings of one place share: the postcode
 *  and the street lines, with case, punctuation, spaces and the common short
 *  forms (Jalan/Jln) evened out. Null without a postcode or a street. */
export function addressKey(
  lines: (string | null | undefined)[],
  postalCode: string | null | undefined,
): string | null {
  const postcode = (postalCode ?? '').replace(/\D/g, '');
  let street = lines
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  for (const [long, short] of SHORT_FORMS) street = street.replace(long, short);
  street = street.replace(/\s+/g, '');
  return postcode.length >= 5 && street.length >= 6
    ? `${postcode}:${street}`
    : null;
}

const nameWords = (name: string) =>
  name
    .normalize('NFC')
    .toLowerCase()
    .split(/[\s.'@/,-]+/)
    .filter(Boolean);

// nameWords(x).join(' ') in SQL, to narrow the candidates; realNameMatch decides.
const NAME_SQL = (col: string) =>
  `btrim(regexp_replace(lower(${col}), '[[:space:].''@/,-]+', ' ', 'g'))`;

/** 'same' when two real names are one name, 'part' when the shorter one (two
 *  words or more) starts the longer: Alex Tan / Alex Tan Tan Seng. One word
 *  alone matches too many strangers to count. */
export function realNameMatch(a: string, b: string): 'same' | 'part' | null {
  const x = nameWords(a);
  const y = nameWords(b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 2 || !short.every((w, i) => long[i] === w)) return null;
  return short.length === long.length ? 'same' : 'part';
}

type Signals = {
  same_browser: boolean;
  /** One entry per network both used: how many accounts used it in all. */
  shared_networks: number[];
  same_delivery_address: boolean;
  real_name: 'same' | 'part' | null;
};

const strength = (s: Signals) =>
  (s.same_browser ? 4 : 0) +
  (s.same_delivery_address ? 3 : 0) +
  (s.real_name ? 2 : 0) +
  (s.shared_networks.length > 0 ? 1 : 0);

export async function accountLinks(input: {
  db: LinksDb;
  packs: Pick<
    PacksModuleService,
    'visitorSignalMatches' | 'createAdminActionAudits'
  >;
  customerId: string;
  adminId: string;
  /** The asker may see browser and network matches (VISITOR_NEED). */
  visitors: boolean;
  /** "Shown name (@handle), open|banned" for each id, in order. */
  label(ids: string[]): Promise<{ id: string; label: string }[]>;
}) {
  const { db, packs, customerId } = input;
  const links = new Map<string, Signals>();
  const of = (id: string) => {
    let s = links.get(id);
    if (!s) {
      s = {
        same_browser: false,
        shared_networks: [],
        same_delivery_address: false,
        real_name: null,
      };
      links.set(id, s);
    }
    return s;
  };

  let leftOut = 0;
  let recorded = false;
  if (input.visitors) {
    const v = await packs.visitorSignalMatches(customerId);
    recorded = v.recorded;
    for (const d of v.device) of(d.customer_id).same_browser = true;
    for (const n of v.ip) {
      // `accounts` counts the OTHER accounts on it: this player makes one more.
      if (n.accounts > MAX_NETWORK_ACCOUNTS) continue;
      for (const id of n.customer_ids)
        of(id).shared_networks.push(n.accounts + 1);
    }
    leftOut =
      v.ip_total -
      v.ip.filter((n) => n.accounts <= MAX_NETWORK_ACCOUNTS).length;
    if (v.device_total > 0 || v.ip_total > 0) {
      try {
        await packs.createAdminActionAudits([
          {
            admin_id: input.adminId,
            entity_type: 'customer',
            entity_id: customerId,
            action: 'reveal',
            before: null,
            // Counts only, as the admin page's panel records them.
            after: { same_browser: v.device_total, same_network: v.ip_total },
            reason: 'visitor signals revealed in the admin assistant',
          },
        ]);
      } catch {
        // Never fail the read on an audit write.
      }
    }
  }

  const mine = (
    await db.raw<{
      address_1: string | null;
      address_2: string | null;
      postal_code: string | null;
    }>(
      'SELECT address_1, address_2, postal_code FROM customer_address WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    )
  ).rows;
  const keys = new Set(
    mine
      .map((a) => addressKey([a.address_1, a.address_2], a.postal_code))
      .filter((k): k is string => k !== null),
  );
  if (keys.size > 0) {
    const postcodes = [...new Set([...keys].map((k) => k.split(':')[0]))];
    const near = (
      await db.raw<{
        customer_id: string;
        address_1: string | null;
        address_2: string | null;
        postal_code: string | null;
      }>(
        `SELECT a.customer_id, a.address_1, a.address_2, a.postal_code FROM customer_address a
           JOIN customer c ON c.id = a.customer_id AND c.deleted_at IS NULL
          WHERE a.deleted_at IS NULL AND a.customer_id <> ?
            AND regexp_replace(coalesce(a.postal_code, ''), '[^0-9]', '', 'g') = ANY(string_to_array(?, ','))
          LIMIT 5000`,
        [customerId, postcodes.join(',')],
      )
    ).rows;
    for (const a of near) {
      const k = addressKey([a.address_1, a.address_2], a.postal_code);
      if (k && keys.has(k)) of(a.customer_id).same_delivery_address = true;
    }
  }

  const [me] = (
    await db.raw<{ real_name: string | null }>(
      'SELECT real_name FROM customer_account_state WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    )
  ).rows;
  const words = me?.real_name ? nameWords(me.real_name) : [];
  if (me?.real_name && words.length >= 2) {
    // Shorter names this one starts with (two words up), and longer ones it starts.
    const prefixes = words
      .slice(1)
      .map((_, i) => words.slice(0, i + 2).join(' '));
    const longer = `${words.join(' ').replace(/[\\%_]/g, '\\$&')} %`;
    const named = (
      await db.raw<{ customer_id: string; real_name: string }>(
        `SELECT s.customer_id, s.real_name FROM customer_account_state s
           JOIN customer c ON c.id = s.customer_id AND c.deleted_at IS NULL
          WHERE s.deleted_at IS NULL AND s.customer_id <> ? AND s.real_name IS NOT NULL
            AND (${NAME_SQL('s.real_name')} = ANY(string_to_array(?, '|'))
                 OR ${NAME_SQL('s.real_name')} LIKE ? ESCAPE '\\')
          LIMIT 50`,
        [customerId, prefixes.join('|'), longer],
      )
    ).rows;
    for (const r of named) {
      const match = realNameMatch(me.real_name, r.real_name);
      if (match) of(r.customer_id).real_name = match;
    }
  }

  const ranked = [...links]
    .sort(([, a], [, b]) => strength(b) - strength(a))
    .slice(0, MAX_ACCOUNTS);
  const labels = await input.label(ranked.map(([id]) => id));
  const accounts = ranked.map(([id, s]) => ({
    account: labels.find((l) => l.id === id)?.label ?? 'a deleted account',
    ...s,
  }));
  return {
    checked: {
      browser_and_network: input.visitors && recorded,
      delivery_address: keys.size > 0,
      real_name: words.length >= 2,
    },
    accounts,
    accounts_total: links.size,
    networks_left_out: leftOut,
    ...(accounts.length === 0
      ? {
          summary:
            'No browser, network, delivery address or real name match was found among what was checked. This is not proof the accounts are unrelated: say no signal was found.',
        }
      : {}),
    ...(!input.visitors
      ? {
          browser_and_network_note:
            'Not checked: the asker’s admin role cannot see browser and network matches (they are fenced like bank details). Say so.',
        }
      : !recorded
        ? {
            browser_and_network_note:
              'Not checked: no visit by this player is recorded (visits are kept from 2026-11-03, for 180 days). Say so.',
          }
        : {}),
    note: 'Review signals for support (ADR 0016), never proof and never a ban reason on their own: a person can switch browsers or networks, mobile networks put many strangers on one IP, and a family shares an address. same_browser: the same browser was signed in to both accounts. shared_networks: one number per network (IP) both used, the accounts that used it in all, this player included; 2 means only these two. networks_left_out: shared networks not looked at, those used by more than 10 other accounts and any past the 10 smallest. same_delivery_address: a saved delivery address that matches once spelling is evened out (Jalan/Jln, spaces, commas). real_name: same = one name; part = the shorter name starts the longer. checked says what was looked at: delivery_address false means this player has no usable saved address, real_name false no real name of two words or more. Bank and holder-name links are in ban_reason. Say what matched in plain words; never repeat an address, IP or real name, and never call accounts unrelated or independent.',
  };
}
