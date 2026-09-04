import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { evictProfileUsername } from '../../utils/profile-cache';
import {
  USERNAME_MAX,
  USERNAME_MIN,
  isValidUsername,
} from '../../utils/profile-handle';
import PacksModuleService from '../../modules/packs/service';
import { PACKS_MODULE } from '../../modules/packs';

// `customer.first_name` is the storefront's "Username"/"Display name" AND the
// public profile URL (/profile/<name>). Medusa's stock customer routes accept
// it as free text, so without this guard a rename could put a space, a slash or
// a duplicate of someone else's name straight into a URL.
//
// This guard is the FRIENDLY layer, not the invariant. The invariant is the
// partial unique index on lower(first_name) (Migration20260904120000): these
// routes are Medusa's own, a public endpoint is a public endpoint, and two
// simultaneous renames can both pass the probe below before either writes. The
// index refuses the loser; this middleware exists so that the overwhelmingly
// common case gets a sentence a person can act on instead of a database error.
//
// Coverage: integration-tests/http/username-guard.spec.ts.
/**
 * The authenticated customer id, or undefined. Read off a widened request
 * rather than typing these guards as authenticated: signup is anonymous, and
 * "no actor" is the right reading there — nobody owns the name yet.
 */
function actorOf(req: MedusaRequest): string | undefined {
  const auth = (req as { auth_context?: { actor_id?: string } }).auth_context;
  return typeof auth?.actor_id === 'string' ? auth.actor_id : undefined;
}

export const CHARSET_MESSAGE =
  `Your display name can use letters, numbers, underscores and hyphens only, ` +
  `and must be ${USERNAME_MIN}-${USERNAME_MAX} characters. It is also your ` +
  `profile link.`;

export function validateUsernameWrite(mode: 'signup' | 'update') {
  return async function usernameGuard(
    req: MedusaRequest,
    _res: MedusaResponse,
    next: MedusaNextFunction,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown> | null | undefined;
      if (!body || typeof body !== 'object' || !('first_name' in body)) {
        // Absent means "don't touch it". On signup the account is created
        // without a name and gets an anonymous one on its first
        // GET /store/profiles/me — an unnamed account is allowed, an
        // unreachable one is not.
        next();
        return;
      }

      const raw = body.first_name;
      const value = typeof raw === 'string' ? raw.trim() : raw;

      if (value === null || value === '' || value === undefined) {
        if (mode === 'signup') {
          // Same as absent: let the lazy assignment name them.
          next();
          return;
        }
        // On update, clearing it would delete a live profile URL out from under
        // every link pointing at it.
        next(
          new MedusaError(
            MedusaError.Types.INVALID_DATA,
            'A display name is required — it is your profile link.',
          ),
        );
        return;
      }

      if (!isValidUsername(value)) {
        next(new MedusaError(MedusaError.Types.INVALID_DATA, CHARSET_MESSAGE));
        return;
      }

      // Normalize the stored value to the trimmed form the checks ran against,
      // so a name saved as " MOONBREON " cannot sit in the DB one character off
      // from the URL that has to match it.
      body.first_name = value;

      const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
      const ownerId = await packs.findCustomerIdByUsername(value);
      // Case-only edits of your own name (moonbreon -> MOONBREON) are a rename
      // of the display, not a claim on someone else's, so the owner check is by
      // id and not by string.
      const selfId = actorOf(req);
      if (ownerId && ownerId !== selfId) {
        next(
          new MedusaError(
            MedusaError.Types.CONFLICT,
            'That display name is already taken.',
          ),
        );
        return;
      }
      next();
    } catch (error) {
      next(error as Error);
    }
  };
}

/**
 * Evict BOTH sides of a rename from the 30s public-profile cache.
 *
 * The new name is obvious; the old one is the half that bites. After a rename
 * the old username's URL must 404, but its cached body is still in the Map and
 * keeps that abandoned profile answering — which reads exactly like "the fix
 * didn't work", for half a minute, on the one URL somebody is most likely to
 * re-check first.
 *
 * The old name is captured BEFORE the write (it is gone afterwards) and both
 * are dropped on `finish`, so a rejected or failed request evicts nothing.
 */
export async function renameProfileCacheEviction(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const body = req.body as Record<string, unknown> | null | undefined;
  const desired =
    typeof body?.first_name === 'string' ? body.first_name.trim() : '';
  const customerId = actorOf(req);
  if (desired === '' || !customerId) {
    next();
    return;
  }
  let previous: string | null = null;
  try {
    const customers = req.scope.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(customerId, {
      select: ['id', 'first_name'],
    });
    previous = customer?.first_name ?? null;
  } catch {
    // Best-effort, like invalidateProfileForCustomer: a missed eviction costs
    // ≤30s of staleness and must never fail the rename itself.
  }
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    evictProfileUsername(previous);
    evictProfileUsername(desired);
  });
  next();
}
