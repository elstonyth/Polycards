import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IAuthModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

/**
 * The admin-disable refusal copy. Exported because the self-service routes echo
 * this exact refusal and Task 7 asserts on the string: three private copies
 * could silently diverge. The guard owns it — this is where the admin-disable
 * block is decided.
 */
export const DISABLED_MESSAGE =
  'This account has been disabled. Please contact support.';

/**
 * The self-disable 403 body. A CODE, not prose: the storefront must be able to
 * tell a self-disable from an admin disable to decide whether to offer
 * reactivation, and `src/lib/actions/auth.ts` already shows what regex-matching
 * human copy costs (a pattern deliberately kept tight so it cannot hijack
 * unrelated text). A code has no such failure mode.
 */
export const SELF_DISABLED_CODE = 'ACCOUNT_SELF_DISABLED';

/**
 * The paths a self-disabled session may reach. Exported so the routes, the
 * guard and the specs all name them once.
 */
export const REACTIVATE_PATH = '/store/customers/me/reactivate';
export const DELETE_PATH = '/store/customers/me/delete';
export const ACCOUNT_INFO_PATH = '/store/customers/me/account';
export const CUSTOMER_ME_PATH = '/store/customers/me';

/**
 * The SELF-disable carve-out set. Deletion is here because a self-disabled
 * customer chose that state and no evidence is at risk: forcing them to
 * reactivate — i.e. to make the account usable again — before they may delete it
 * is a pointless detour for the population most likely to want deletion.
 * ACCOUNT_INFO_PATH rides along because the Settings page cannot render the
 * Danger zone without knowing whether to ask for a password.
 *
 * CUSTOMER_ME_PATH is here because the two above were necessary but NOT
 * sufficient: /settings renders behind the account layout, which calls
 * getCustomer() -> GET /store/customers/me. Without this entry that read 403s,
 * getCustomer() swallows it and returns null, and the layout redirects to
 * /?auth=login — bouncing a self-disabled customer away from the very page
 * holding the Delete button, leaving the delete route reachable by direct API
 * call only.
 *
 * Matching is on the PATH only, not the method, so this admits
 * POST /store/customers/me (a profile update) as well as the GET. That is
 * accepted, but NOT on the general principle that "reactivate is open anyway so
 * nothing here grants new capability" — read broadly that would also license
 * admitting /store/credits/withdraw, which it must not. The rule is narrower and
 * has to be re-checked PER PATH: each admitted path must reach neither money nor
 * auth. For this one specifically, `metadata` (which carries bank_accounts) is
 * rejected in full by rejectCustomerMetadata, and `email` is create-only, so the
 * writable surface is name/phone.
 *
 * That money control is LOAD-BEARING on the shape of the carve-out below: it
 * calls a bare next(), so the request continues into the per-route middleware
 * stack where rejectCustomerMetadata is wired (middlewares.ts, matcher
 * '/store/customers/me' + method POST). Anyone reshaping this branch to
 * short-circuit — responding here, or routing around the remaining stack —
 * deletes that guard along with it.
 *
 * This set is consulted ONLY on the `self` branch. The ADMIN branch stays
 * total, and that asymmetry is the whole point: a banned account reaching the
 * delete route would purge the payout details and withdrawal counterparties the
 * ban exists to preserve.
 *
 * Membership is EXACT, never a prefix: /store/customers/me/addresses and every
 * other sub-path of the four stay blocked. The spec pins that.
 */
const SELF_DISABLED_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  REACTIVATE_PATH,
  DELETE_PATH,
  ACCOUNT_INFO_PATH,
  CUSTOMER_ME_PATH,
]);

// Both guards fail CLOSED: an unexpected error is handed to next(e), which the
// framework error handler turns into a 500 — never a silent pass.

// Login-time block (POLYCARD-BACK §4.2): reject emailpass login for a disabled
// customer BEFORE the core route mints a token. Unknown emails fall through to
// the core route, so this reveals nothing login itself would not.
//
// The customer is resolved through the AUTH IDENTITY, which is the key
// authentication itself uses — never through customer.email. Nothing
// reconciles the customer row's `email` column with
// provider_identities.entity_id (POST /store/customers takes the email
// straight from the request body, and the unique index is on
// (email, has_account), so an anonymously-creatable guest twin can share an
// email with a real account). Joining on email was therefore both bypassable
// (a disabled player with a mismatched/null email logs in) and prone to
// misfiring (a disabled guest twin locks out an innocent account). Resolving
// entity_id -> app_metadata.customer_id is exactly how login derives the
// token's actor_id (core-flows setAuthAppMetadataStep keys it
// `${actorType}_id`), so this guard and the session guard now agree on one id.
export async function blockDisabledEmailpassLogin(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  try {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== 'string' || email === '') {
      next();
      return;
    }
    const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
    const [identity] = await auth.listAuthIdentities(
      { provider_identities: { provider: 'emailpass', entity_id: email } },
      { take: 1 },
    );
    const customerId = identity?.app_metadata?.customer_id;
    // No identity, or one not yet linked to a customer (a register token
    // carries no customer_id until POST /store/customers runs) — nothing to
    // decide on, so fall through to the core route.
    if (typeof customerId !== 'string' || customerId === '') {
      next();
      return;
    }
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    // Only a SELF disable is let through at the token exchange, and the test is
    // written that way round on purpose: `=== 'self'` to GRANT, never
    // `=== 'admin'` to deny. The inverted form is safe only for exactly the two
    // values that exist today — any third one (a future writer, a bad backfill)
    // would fall through it as a silent login bypass. A self-disabled customer
    // must be able to mint a token, because reactivation is offered only after
    // the password is proven: refusing here would announce the account's state to
    // anyone who guessed the email, and would leave the customer no way back in.
    const cause = await packs.accountDisabledCause(customerId);
    if (cause !== null && cause !== 'self') {
      next(new MedusaError(MedusaError.Types.UNAUTHORIZED, DISABLED_MESSAGE));
      return;
    }
    next();
  } catch (e) {
    next(e as Error);
  }
}

// Session-time block: rejects /store requests whose verified bearer belongs to
// a disabled customer — TOTAL for an ADMIN disable, but for a SELF-disable
// everything EXCEPT the four exact paths in SELF_DISABLED_ALLOWED_PATHS above:
// reactivate, delete, account-info, and /store/customers/me itself. Anyone
// reading this as a blanket block will size a change wrong; the carve-out is
// four members, matched exactly, self-only.
//
// Registered as a blanket /store/* matcher. It does NOT rely on this file's
// per-route authenticate() entries — the routes sorter hoists a method-less
// matcher into the `global` bucket, AHEAD of them. What populates
// req.auth_context is the framework's own store-wide auth pass, registered
// before any middleware from middlewares.ts; see the full mechanism at
// middlewares.ts:663-672. Unauthenticated/public routes carry no
// auth_context and pass through untouched. A Google-minted token gets no
// separate treatment: the google callback itself is not guarded, so what that
// token can do is decided HERE and nowhere else — for an ADMIN-disabled
// customer it works nowhere, and for a SELF-disabled one it works on exactly
// the four carved-out paths. That second half is a REQUIREMENT, not a leak:
// it is what carries the Google side of the reactivate flow, whose customer has
// no password to prove and no other route back into the account.
//
// FORBIDDEN, not NOT_ALLOWED: this framework's error handler maps NOT_ALLOWED
// to 400 and FORBIDDEN to 403 (node_modules/@medusajs/framework/dist/http/
// middlewares/error-handler.js) — 403 is the contracted status, and the right
// semantics for "authenticated, but this account may not act".
export async function blockDisabledCustomerSession(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  try {
    const auth = (
      req as { auth_context?: { actor_id?: string; actor_type?: string } }
    ).auth_context;
    if (!auth?.actor_id || auth.actor_type !== 'customer') {
      next();
      return;
    }
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    const cause = await packs.accountDisabledCause(auth.actor_id);
    if (cause === null) {
      next();
      return;
    }
    if (cause === 'self') {
      // The carve-out. It lives HERE, inside the existing guard, rather
      // than as a separate middleware entry: this guard is registered as a
      // blanket method-less '/store/*' matcher, which the routes sorter hoists
      // into the `global` bucket AHEAD of every per-route entry. A
      // separately-registered exception would simply never run.
      //
      // It reads `originalUrl`, NOT `req.path`. Method-less registration takes
      // the framework's `app.use(matcher, handler)` branch, and Express strips
      // the matched prefix there: `req.path` is '/' inside this handler, so a
      // `req.path === REACTIVATE_PATH` test is ALWAYS false and every path a
      // self-disabled customer is allowed to use would 403 like everything else.
      // The repo's other `req.path` readers all sit on entries carrying
      // `method:`, which does not strip — the difference is the registration.
      // Normalized the same way rate-limit.ts:569 already does it.
      const reqPath = (req.originalUrl ?? '')
        .split('?')[0]
        .toLowerCase()
        .replace(/\/+$/, '');
      if (SELF_DISABLED_ALLOWED_PATHS.has(reqPath)) {
        next();
        return;
      }
      next(new MedusaError(MedusaError.Types.FORBIDDEN, SELF_DISABLED_CODE));
      return;
    }
    next(new MedusaError(MedusaError.Types.FORBIDDEN, DISABLED_MESSAGE));
    return;
  } catch (e) {
    next(e as Error);
  }
}
