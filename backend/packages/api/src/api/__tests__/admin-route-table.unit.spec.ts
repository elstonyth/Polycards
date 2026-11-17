/**
 * The admin route table (admin-rbac.ts ADMIN_ROUTES) is what middlewares.ts
 * registers: this loads the real middlewares.ts config, with each limiter
 * replaced by a labelled stand-in, and checks every record's entries are
 * there. The coverage specs beside this one read the table itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ADMIN_ROUTES,
  adminRbacRoutes,
  deskBotBlockedRoutes,
} from '../admin-rbac';
import { blockedReason } from '../reports/admin/proxy';
import {
  API_ROOT,
  collectRouteFiles,
  getMethodsOf,
  matcherToRegExp,
  mutationMethodsOf,
  routeFileToUrl,
} from './rate-limit-coverage-helpers';

type Labelled = { __label?: string; name?: string };

// One stand-in per rateLimit() call, numbered per tier: a second instance of
// a tier (a split budget) shows up as `#2`.
jest.mock('../utils/rate-limit', () => {
  const actual = jest.requireActual('../utils/rate-limit');
  const made: Record<string, number> = {};
  return {
    ...actual,
    rateLimit: (name: string) => {
      made[name] = (made[name] ?? 0) + 1;
      return Object.assign(
        (_req: unknown, _res: unknown, next: () => void) => next(),
        { __label: `${name}#${made[name]}` },
      );
    },
    warmOtpSendBudget: () => undefined,
    warmSignupProofClaims: () => undefined,
  };
});

type Entry = {
  matcher: string;
  methods?: string[];
  middlewares: Labelled[];
  policies?: unknown;
  bodyParser?: unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('../middlewares').default as { routes: Entry[] };
const routes = config.routes;
const label = (m: Labelled) => m.__label ?? '';
const key = (r: { matcher: string; method: string }) =>
  `${r.method} ${r.matcher}`;

describe('admin route table', () => {
  it('lists each route once', () => {
    const keys = ADMIN_ROUTES.map(key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    expect(ADMIN_ROUTES.length).toBeGreaterThan(80);
  });

  it('middlewares.ts registers every record, limiters after every RBAC entry', () => {
    // Only the RBAC entries carry policies, all in one block.
    const firstRbac = routes.findIndex((r) => r.policies);
    const lastRbac = routes.reduce((at, r, i) => (r.policies ? i : at), -1);
    expect(lastRbac - firstRbac + 1).toBe(adminRbacRoutes.length);
    const failures: string[] = [];
    for (const r of ADMIN_ROUTES) {
      const own = (e: Entry) =>
        e.matcher === r.matcher &&
        e.methods?.length === 1 &&
        e.methods[0] === r.method;
      // A prefix entry can share the matcher (`/admin/announcements/*`), so
      // look for the record's own policy, not just any.
      const ownPolicy = routes.filter(
        (e) =>
          own(e) &&
          r.policy &&
          JSON.stringify(e.policies) === JSON.stringify([r.policy]),
      );
      if (ownPolicy.length !== (r.policy ? 1 : 0)) {
        failures.push(`${key(r)}: RBAC entry`);
      }
      const limited = routes
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => own(e) && !e.policies);
      const want = (r.limits ?? []).map((l) => `${l}#1`);
      if (!r.limits) {
        if (limited.length) failures.push(`${key(r)}: unexpected entry`);
        continue;
      }
      const got = limited.map(({ e }) =>
        e.middlewares.map(label).filter(Boolean),
      );
      if (
        limited.length !== 1 ||
        JSON.stringify(got[0]) !== JSON.stringify(want) ||
        limited[0].i < lastRbac
      ) {
        failures.push(`${key(r)}: limiter entry ${JSON.stringify(got)}`);
        continue;
      }
      const { e } = limited[0];
      // The late JSON parser is the one middleware after the limiters.
      const late = r.lateJsonBody
        ? e.bodyParser === false &&
          e.middlewares.length === want.length + 1 &&
          e.middlewares.at(-1)?.name === 'jsonParser'
        : e.bodyParser === undefined && e.middlewares.length === want.length;
      if (!late) failures.push(`${key(r)}: body parsing`);
    }
    expect(failures).toEqual([]);
  });

  it('every record but core routes names a real route method', () => {
    const real = collectRouteFiles(path.join(API_ROOT, 'admin')).flatMap(
      (relPath) => {
        const text = fs.readFileSync(path.join(API_ROOT, relPath), 'utf8');
        const url = routeFileToUrl(relPath);
        return [
          ...(getMethodsOf(text) ? ['GET'] : []),
          ...mutationMethodsOf(text),
        ].map((method) => ({ url, method }));
      },
    );
    const stale = ADMIN_ROUTES.filter(
      (r) =>
        !r.coreRoute &&
        !real.some(
          (x) =>
            x.method === r.method &&
            matcherToRegExp(r.matcher.replace(/:[A-Za-z_]\w*/g, '*')).test(
              x.url,
            ),
        ),
    ).map(key);
    expect(stale).toEqual([]);
  });

  it('a secret read asks for its own read policy and the admin-action budget', () => {
    for (const r of ADMIN_ROUTES.filter((x) => x.secret)) {
      expect([r.method, r.policy?.operation, r.limits]).toEqual([
        'GET',
        'read',
        ['admin-action'],
      ]);
    }
  });

  // The order a request actually runs its middlewares in: entries flattened
  // as Medusa's MiddlewareFileLoader does, sorted by its RoutesSorter, then
  // matched the way Express matches them (a method-less entry is `app.use`,
  // a prefix match). Pinned on chains taken from master before the table:
  // the guards outside the table must keep running before its limiters.
  it('guards outside the table still run before the table limiters', () => {
    const httpDir = path.dirname(require.resolve('@medusajs/framework/http'));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RoutesSorter } = require(path.join(httpDir, 'routes-sorter.js'));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Layer = require('express/lib/router/layer');
    const rows = routes.flatMap((e) =>
      (e.middlewares.length ? e.middlewares : [{}]).map((m) => ({
        matcher: e.matcher,
        methods: e.methods,
        handler: m,
        name: e.policies
          ? `policy ${(e.policies as { resource: string; operation: string }[])
              .map((p) => `${p.resource}:${p.operation}`)
              .join(',')}`
          : label(m) || (m as Labelled).name,
        layer: new Layer(
          e.matcher,
          { sensitive: false, strict: false, end: !!e.methods },
          () => {},
        ),
      })),
    );
    const sorted = new RoutesSorter(rows).sort() as typeof rows;
    const chain = (method: string, url: string) =>
      sorted
        .filter(
          (r) =>
            (!r.methods || r.methods.includes(method)) && r.layer.match(url),
        )
        .map((r) => r.name);
    const adminGuards = [
      'refuseCrossOriginAdminWrite',
      'capAdminSessionAge',
      'requireAdminAuthenticator',
      'redactCustomerSecrets',
      'noStoreForAuthenticatedAdmin',
    ];
    expect(chain('POST', '/admin/customers/cus_1/phone')).toEqual([
      ...adminGuards,
      'rejectAdminBankAccountsMetadata',
      'rejectAdminPhoneWrite',
      'policy customer:update',
      'admin-action#1',
    ]);
    expect(chain('POST', '/admin/customer-groups/cusgroup_1/policy')).toEqual([
      ...adminGuards,
      'stripAdditionalData',
      'rejectGroupPolicyMetadata',
      'rejectGroupOddsSetUpdate',
      'policy customer_group:update',
      'admin-action#1',
    ]);
    expect(chain('POST', '/admin/customers')).toEqual([
      ...adminGuards,
      'rejectAdminBankAccountsMetadata',
      'rejectAdminPhoneWrite',
    ]);
    expect(chain('POST', '/admin/assistant/chat')).toEqual([
      ...adminGuards,
      'policy assistant:update',
      'admin-action#1',
      'assistant-chat#1',
      'jsonParser',
    ]);
  });

  it('per-route desk-bot blocks keep their pattern and reach the proxy', () => {
    expect(deskBotBlockedRoutes.map(([re]) => re.source)).toEqual([
      '^\\/admin\\/customers\\/[^/]+\\/visitor-signals(\\/|$)',
    ]);
    for (const r of ADMIN_ROUTES.filter((x) => x.deskBotsBlocked)) {
      const sample = r.matcher.replace(/\*/g, 'cus_1');
      expect(blockedReason(sample)).toBe(r.deskBotsBlocked);
      expect(blockedReason(`${sample}/x`)).toBe(r.deskBotsBlocked);
    }
    expect(blockedReason('/admin/customers/a/b/visitor-signals')).toBeNull();
  });
});
