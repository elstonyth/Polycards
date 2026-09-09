import { randomInt } from 'node:crypto';
import type {
  IAuthModuleService,
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { setPlayerGroup } from '../modules/packs/player-groups';
import { generatedUsername } from './profile-handle';

/**
 * Partner account generator (POST /admin/players, GET /admin/players/export).
 *
 * An operator mints storefront logins in bulk and hands them out, so the
 * generated password has to be readable AFTER creation — the auth module only
 * keeps a hash. It is kept on the customer row under
 * `metadata.partner_credential`, which is also the marker the export scans
 * for. ponytail: plaintext at rest, scoped to operator-minted accounts and
 * readable only through admin-authenticated, rate-limited routes (and by the
 * account's own /store/customers/me); encrypt with an env key if that ever
 * stops being acceptable.
 */
export const PARTNER_CREDENTIAL_KEY = 'partner_credential';

export type PartnerCredential = { password: string; issued_at: string };

export type PartnerAccountRow = {
  id: string;
  email: string;
  password: string;
  name: string | null;
  group: string | null;
  created_at: string;
};

const EMAIL_DOMAIN = 'polycards.gg';
// Lowercase + digits minus the look-alikes (0/o, 1/l): these get read out
// loud and typed by hand.
const EMAIL_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
// Same set plus uppercase, no symbols — 16 chars is ~90 bits, and a
// symbol-free password survives being pasted into a chat app or a cell.
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const pick = (alphabet: string, n: number): string =>
  Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join(
    '',
  );

/** `partner-xxxxxx@polycards.gg` — the prefix says what the account is for in
 *  the Players list. */
export const generatePartnerEmail = (): string =>
  `partner-${pick(EMAIL_ALPHABET, 6)}@${EMAIL_DOMAIN}`;

export const generatePartnerPassword = (): string =>
  pick(PASSWORD_ALPHABET, 16);

/** The stored credential, or null when the row was not minted here. */
export const partnerCredentialOf = (
  metadata: Record<string, unknown> | null | undefined,
): PartnerCredential | null => {
  const v = metadata?.[PARTNER_CREDENTIAL_KEY] as
    Partial<PartnerCredential> | undefined;
  return v && typeof v.password === 'string'
    ? { password: v.password, issued_at: String(v.issued_at ?? '') }
    : null;
};

/**
 * Mint ONE login-able partner account: emailpass identity → customer row
 * (has_account, credential in metadata) → identity linked to it
 * (app_metadata.customer_id, the claim the session token carries) → display
 * name claimed → filed into exactly one player group. The seed's
 * test-customer block and scripts/reset-customer-password.ts do the same
 * identity dance.
 *
 * Module services directly, NOT createCustomerAccountWorkflow: the workflow
 * emits customer.created, whose subscriber files the player into DEFAULT
 * asynchronously — racing the explicit group write and leaving them in two
 * groups. No event also means no free-welcome-pack stamp, which is right for
 * an operator-minted account.
 *
 * `displayName` null = auto ("Collector####" from the new id). A typed name
 * goes through claimUsername like every other write, so a second account in
 * the same batch gets a numbered variant instead of a unique-index error.
 *
 * Unwind: the identity is registered FIRST because it is the write the
 * provider refuses on a duplicate; anything failing after it removes both
 * halves so the email is not stranded on a login that points at nothing.
 */
export async function mintPartnerAccount(
  container: MedusaContainer,
  input: { displayName: string | null; groupId: string | null },
): Promise<PartnerAccountRow> {
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  // `email` is unique among has_account rows. 32^6 candidates makes a hit
  // vanishingly rare; the loop is for the provider, which would otherwise
  // refuse the register below and fail the whole batch on bad luck.
  let email = '';
  for (let attempt = 0; attempt < 5 && !email; attempt++) {
    const candidate = generatePartnerEmail();
    const [taken] = await customers.listCustomers(
      { email: candidate, has_account: true },
      { select: ['id'], take: 1 },
    );
    if (!taken) email = candidate;
  }
  if (!email) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Could not find a free partner email after 5 tries.',
    );
  }
  const password = generatePartnerPassword();

  const { authIdentity, error } = await auth.register('emailpass', {
    body: { email, password },
  });
  if (error || !authIdentity) {
    throw new MedusaError(
      MedusaError.Types.DUPLICATE_ERROR,
      typeof error === 'string'
        ? error
        : `A login for ${email} already exists.`,
    );
  }

  let customerId: string | undefined;
  try {
    const issuedAt = new Date().toISOString();
    const [customer] = await customers.createCustomers([
      {
        email,
        has_account: true,
        metadata: {
          [PARTNER_CREDENTIAL_KEY]: { password, issued_at: issuedAt },
        },
      },
    ]);
    customerId = customer.id;
    await auth.updateAuthIdentities({
      id: authIdentity.id,
      app_metadata: { customer_id: customerId },
    });
    const name = await packs.claimUsername({
      customerId,
      desired: input.displayName ?? generatedUsername(customerId),
    });
    const group = await setPlayerGroup(container, customerId, input.groupId);
    return {
      id: customerId,
      email,
      password,
      name,
      group: group.name,
      created_at: new Date(customer.created_at ?? issuedAt).toISOString(),
    };
  } catch (e) {
    // Best-effort unwind; the ORIGINAL error is what surfaces.
    await Promise.allSettled([
      auth.deleteAuthIdentities([authIdentity.id]),
      customerId ? customers.deleteCustomers([customerId]) : undefined,
    ]);
    throw e;
  }
}

const PAGE = 500;

/**
 * Every account minted here (marker: the stored credential), newest first,
 * or just the given ids. ponytail: metadata is not a customer-module filter,
 * so this pages every has_account row and filters in JS — fine at the current
 * player count; a dedicated column if it ever shows up in a profile.
 */
export async function listPartnerAccounts(
  container: MedusaContainer,
  ids?: string[],
): Promise<PartnerAccountRow[]> {
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const rows: PartnerAccountRow[] = [];
  let skip = 0;
  for (;;) {
    const [page, total] = await customers.listAndCountCustomers(
      ids ? { id: ids } : { has_account: true },
      {
        skip,
        take: PAGE,
        order: { created_at: 'DESC', id: 'DESC' },
        relations: ['groups'],
      },
    );
    for (const c of page) {
      const cred = partnerCredentialOf(c.metadata);
      if (!cred) continue;
      rows.push({
        id: c.id,
        email: c.email,
        password: cred.password,
        name: c.first_name ?? null,
        // groups[0], the same cell the Players list shows.
        group: c.groups?.[0]?.name ?? null,
        created_at: new Date(c.created_at).toISOString(),
      });
    }
    skip += PAGE;
    if (page.length === 0 || skip >= total) break;
  }
  return rows;
}
