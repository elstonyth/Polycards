import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

const DISABLED_MESSAGE = 'This account has been disabled. Please contact support.';

// Login-time block (POLYCARD-BACK §4.2): reject emailpass login for a disabled
// customer BEFORE the core route mints a token. Unknown emails fall through to
// the core route, so this reveals nothing login itself would not.
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
    const customers = req.scope.resolve<ICustomerModuleService>(
      Modules.CUSTOMER,
    );
    const [customer] = await customers.listCustomers({ email }, { take: 1 });
    if (!customer) {
      next();
      return;
    }
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    if (await packs.isAccountDisabled(customer.id)) {
      next(new MedusaError(MedusaError.Types.UNAUTHORIZED, DISABLED_MESSAGE));
      return;
    }
    next();
  } catch (e) {
    next(e as Error);
  }
}

// Session-time block: rejects any /store request whose verified bearer belongs
// to a disabled customer. Registered as a blanket /store/* matcher placed AFTER
// the per-route authenticate() entries so req.auth_context is populated when it
// runs; unauthenticated/public routes pass through untouched. A Google-minted
// token for a disabled customer is unusable for the same reason (the google
// callback itself is not guarded — the token it mints works nowhere).
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
    if (await packs.isAccountDisabled(auth.actor_id)) {
      next(new MedusaError(MedusaError.Types.FORBIDDEN, DISABLED_MESSAGE));
      return;
    }
    next();
  } catch (e) {
    next(e as Error);
  }
}
