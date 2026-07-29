import Redis from "ioredis";
import { Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import {
  DEFAULT_MARKET_MULTIPLIER,
  DEFAULT_USD_MYR,
} from "../../src/modules/packs/pricing";

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
