import Redis from "ioredis";
import { Modules } from "@medusajs/framework/utils";
import type {
  ICustomerModuleService,
  MedusaContainer,
} from "@medusajs/framework/types";
import {
  DEFAULT_MARKET_MULTIPLIER,
  DEFAULT_USD_MYR,
} from "../../src/modules/packs/pricing";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { isPhoneVerificationRequired } from "../../src/utils/phone-verification";

// Shared harness policy for the HTTP suites — the two idioms every suite was
// copy-pasting. Not a spec file (jest's http testMatch only picks *.spec.ts).

/**
 * Resolves to the axios response for BOTH 2xx and error statuses — the suites
 * assert on 4xx/429 bodies, so HTTP errors must come back as values, while
 * transport errors (no response at all) still throw.
 *
 * Typed `any` on purpose: the runner's api client is an untyped axios-like,
 * and pinning a response shape here would force every suite to re-assert the
 * fields it reads (status/data/headers vary per assertion).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const unwrapResponse = (promise: Promise<any>): Promise<any> =>
  promise.then(
    (r) => r,
    (e: { response?: unknown }) => {
      if (!e.response) throw e;
      return e.response;
    },
  );

/**
 * Mints a SUPER-ADMIN user and returns a logged-in bearer token — the way the
 * `medusa user` CLI does it. RBAC is enabled in this backend, so a role-less
 * user authenticates fine but 403s on every /admin/* route; the user must be
 * created CARRYING the super-admin role (an RBAC extension of the user DTO,
 * hence the untyped workflow-engine run, mirroring the CLI).
 */
export async function mintSuperAdmin(
  container: MedusaContainer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  email: string,
  password: string,
): Promise<string> {
  const rbacService = container.resolve(Modules.RBAC) as unknown as {
    listRbacRoles: (f: { id: string }) => Promise<{ id: string }[]>;
  };
  const superAdminRoles = await rbacService.listRbacRoles({
    id: "role_super_admin",
  });
  if (superAdminRoles.length === 0) {
    // A role-less user authenticates fine but 403s on every /admin/* call —
    // fail loudly here instead of producing confusing downstream failures.
    throw new Error("role_super_admin not found — RBAC seed missing?");
  }
  const workflowService = container.resolve(Modules.WORKFLOW_ENGINE);
  const { result: users } = await workflowService.run("create-users-workflow", {
    input: {
      users: [{ email, roles: superAdminRoles.map((r) => r.id) }],
    },
  });
  const authService = container.resolve(Modules.AUTH);
  const { authIdentity } = await authService.register("emailpass", {
    body: { email, password },
  } as Parameters<typeof authService.register>[1]);
  if (!authIdentity) {
    throw new Error(
      `authService.register returned no authIdentity for ${email}`,
    );
  }
  await authService.updateAuthIdentities({
    id: authIdentity.id,
    app_metadata: { user_id: (users as { id: string }[])[0].id },
  });
  const login = await api.post("/auth/user/emailpass", { email, password });
  return login.data.token as string;
}

/**
 * The MYR display value the pricing seam produces for a raw USD FMV when a
 * suite seeds NO FxRate row and cards keep the model-default multiplier —
 * i.e. displayMarketPrice(usd, DEFAULT_USD_MYR, DEFAULT_MARKET_MULTIPLIER).
 * Imported from the production constants so the specs can't silently drift
 * from the real formula.
 */
export const myrDisplay = (usd: number): number =>
  Math.round(usd * DEFAULT_MARKET_MULTIPLIER * DEFAULT_USD_MYR * 100) / 100;

/**
 * One redis for the whole HTTP harness: CI exports REDIS_URL; locally the
 * pokenic-redis container answers on the default. Suites that assert on the
 * app-under-test's rl:* keys must ALSO put this into their runner env — the
 * limiter reads process.env.REDIS_URL at boot and silently falls back to its
 * in-memory store when unset, leaving this probe inspecting an empty redis.
 */
export const TEST_REDIS_URL =
  process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Connects to the test Redis or THROWS — deliberately no skip: the rate
 * limiter silently fails over to its in-memory store, so a suite that skipped
 * this probe would stay green even with the Redis path broken. `purpose` says
 * what the suite needs Redis for, verbatim, in the failure message.
 */
export async function connectTestRedisOrFail(purpose: string): Promise<Redis> {
  const url = TEST_REDIS_URL;
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", () => {
    /* assertions surface failures; avoid unhandled 'error' events */
  });
  try {
    await redis.connect();
  } catch (err) {
    throw new Error(
      `Redis unreachable at ${url} — ${purpose}. Start it: docker start pokenic-redis. (${err})`,
    );
  }
  return redis;
}

/**
 * POST /store/customers, then WAIT for the customer.created subscribers to land
 * their writes. Drop-in replacement for `api.post("/store/customers", …)` —
 * same arguments after the two harness ones, same thrown-on-4xx behaviour.
 *
 * WHY: createCustomersWorkflow emits customer.created and the route answers 200
 * WITHOUT awaiting the subscribers (the local event bus is a bare EventEmitter
 * and keeps no handles). Two subscribers then write:
 *   - customer-default-group  -> INSERT customer_group_customer   (always)
 *   - customer-phone-verified -> upsert customer_account_state     (only when
 *     PHONE_VERIFICATION_REQUIRED is on AND the customer carries a phone)
 *
 * The runner TRUNCATEs ~200 tables in its PER-TEST teardown
 * (@medusajs/test-utils medusa-test-runner.js: afterEach -> dbUtils.teardown),
 * so either write can meet that TRUNCATE mid-flight and deadlock on a
 * lock-order inversion — TRUNCATE holds AccessExclusive on the FK parent and
 * waits for it on the pivot, while the insert holds the pivot and wants
 * RowShare on the parent. Whichever session's deadlock_timeout expires first is
 * the victim, which is why this reads as intermittent: the subscriber losing is
 * swallowed into a "[customer-default-group] could not assign …" warn and the
 * suite stays GREEN, while the TRUNCATE losing fails teardown and reds it.
 *
 * Draining here removes the race rather than re-winning it. It is deliberately
 * a HARNESS wait: fire-and-forget is correct in production, where the insert
 * landing a beat after the 200 costs nothing and making it synchronous would be
 * a real latency regression on a cosmetic write.
 */
export async function postStoreCustomer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  container: MedusaContainer,
  body: Record<string, unknown>,
  config?: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await api.post("/store/customers", body, config);
  const customer = res?.data?.customer as
    | { id?: string; phone?: string | null }
    | undefined;
  if (customer?.id) {
    await drainCustomerCreated(container, customer.id, customer.phone);
  }
  return res;
}

/** How long a subscriber write may take before the wait is called a failure. */
const DRAIN_TIMEOUT_MS = 15_000;

/**
 * Polls until both customer.created subscribers have landed for `customerId`.
 * Throws (loudly, naming which half is missing) rather than returning early —
 * a silent give-up would put the flake straight back.
 */
async function drainCustomerCreated(
  container: MedusaContainer,
  customerId: string,
  phone?: string | null,
): Promise<void> {
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  // Mirrors customer-phone-verified.ts's own gate: with either half false that
  // subscriber returns having written nothing, so there is nothing to wait for.
  const packs =
    isPhoneVerificationRequired(process.env) &&
    typeof phone === "string" &&
    phone !== ""
      ? container.resolve<PacksModuleService>(PACKS_MODULE)
      : null;

  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const grouped =
      (await customers.listCustomerGroupCustomers({ customer_id: customerId }))
        .length > 0;
    const stamped =
      !packs ||
      (
        await packs.listCustomerAccountStates({ customer_id: customerId })
      ).some((s: { phone_verified_at?: Date | null }) => !!s.phone_verified_at);
    if (grouped && stamped) return;
    if (Date.now() > deadline) {
      throw new Error(
        `customer.created subscribers did not land for ${customerId} within ` +
          `${DRAIN_TIMEOUT_MS}ms (default group: ${grouped}, phone stamp: ` +
          `${stamped}) — look for a swallowed subscriber warn in the run log.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
