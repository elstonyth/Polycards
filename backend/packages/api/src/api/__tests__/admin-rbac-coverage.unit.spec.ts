/**
 * Coverage guard for admin RBAC (2026-10-17). Every custom admin route ran
 * without a policy check until api/admin-rbac.ts; this makes the next route
 * that ships outside the table fail here instead of in a security review.
 *
 * Text scan of src/api/admin/**\/route.ts (the rate-limit guard's helpers)
 * against the table itself — no framework boot, no DB.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CORE_PREFIX_WRITES,
  CORE_READ_PREFIXES,
  CUSTOM_ADMIN_RESOURCES,
  SECRET_READS,
  adminRbacRoutes,
} from '../admin-rbac';
import {
  adminSurfacePolicies,
  secretReadPolicies,
} from '../../policies/admin-surfaces';
import {
  API_ROOT,
  collectRouteFiles,
  getMethodsOf,
  matcherToRegExp,
  mutationMethodsOf,
  routeFileToUrl,
} from './rate-limit-coverage-helpers';

const entries = adminRbacRoutes.map((r) => ({
  matcher: r.matcher as string,
  methods: (r.methods ?? []) as string[],
  re: matcherToRegExp(r.matcher as string),
  policies: r.policies as { resource: string; operation: string }[],
}));

const routes = collectRouteFiles(path.join(API_ROOT, 'admin')).flatMap(
  (relPath) => {
    const text = fs.readFileSync(path.join(API_ROOT, relPath), 'utf8');
    const methods = [
      ...(getMethodsOf(text) ? ['GET'] : []),
      ...mutationMethodsOf(text),
    ];
    const url = routeFileToUrl(relPath);
    return methods.map((method) => ({ relPath, url, method }));
  },
);

const prefixOf = (url: string) => url.split('/')[2];

describe('admin RBAC coverage', () => {
  it('scans real routes and real entries (not vacuously green)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(entries.length).toBeGreaterThan(100);
    expect(
      routes.some(
        (r) =>
          r.method === 'POST' && r.url === '/admin/referrals/settlements/*/pay',
      ),
    ).toBe(true);
  });

  it('every admin route method asks for a policy', () => {
    const failures: string[] = [];
    for (const { relPath, url, method } of routes) {
      const ours = entries.some(
        (e) => e.methods.includes(method) && e.re.test(url),
      );
      // Core's own `/admin/<prefix>/*` entry asks for read on every method,
      // which is all a GET needs.
      const core = method === 'GET' && prefixOf(url) in CORE_READ_PREFIXES;
      if (!ours && !core) {
        failures.push(
          `${method} ${url} (src/api/${relPath}) has no RBAC policy — add its ` +
            'prefix to CUSTOM_ADMIN_RESOURCES or the route to CORE_PREFIX_WRITES',
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('every admin route prefix is in exactly one table', () => {
    const custom = new Set(Object.keys(CUSTOM_ADMIN_RESOURCES));
    const core = new Set(Object.keys(CORE_READ_PREFIXES));
    for (const prefix of custom) expect(core.has(prefix)).toBe(false);
    const unknown = [...new Set(routes.map((r) => prefixOf(r.url)))].filter(
      (p) => !custom.has(p) && !core.has(p),
    );
    expect(unknown).toEqual([]);
  });

  it('no table entry is stale', () => {
    const prefixes = new Set(routes.map((r) => prefixOf(r.url)));
    const stalePrefixes = Object.keys(CUSTOM_ADMIN_RESOURCES).filter(
      (p) => !prefixes.has(p),
    );
    const staleWrites = CORE_PREFIX_WRITES.filter(
      (w) =>
        !routes.some(
          (r) =>
            r.method === w.method && matcherToRegExp(w.matcher).test(r.url),
        ),
    ).map((w) => `${w.method} ${w.matcher}`);
    expect([...stalePrefixes, ...staleWrites]).toEqual([]);
  });

  it('declares exactly the custom resources the middleware checks', () => {
    // definePolicies snake-cases resource names; the table must already be
    // snake_case or a future limited role would be granted a different string
    // than the middleware asks for.
    const declared = new Set(
      adminSurfacePolicies.policies.map((p) => `${p.resource}:${p.operation}`),
    );
    const checked = new Set(
      entries
        .flatMap((e) => e.policies)
        .filter((p) =>
          (Object.values(CUSTOM_ADMIN_RESOURCES) as string[]).includes(
            p.resource,
          ),
        )
        .map((p) => `${p.resource}:${p.operation}`),
    );
    expect([...checked].sort()).toEqual([...declared].sort());
  });

  it('money writes ask for a write policy, not just read', () => {
    const policyFor = (method: string, url: string) =>
      entries
        .filter((e) => e.methods.includes(method) && e.re.test(url))
        .flatMap((e) => e.policies.map((p) => `${p.resource}:${p.operation}`));
    expect(policyFor('POST', '/admin/referrals/settlements/*/pay')).toEqual([
      'referral:update',
    ]);
    expect(policyFor('POST', '/admin/customers/*/credits')).toEqual([
      'customer:update',
    ]);
    expect(policyFor('POST', '/admin/payments/withdrawals/*/approve')).toEqual([
      'payment:update',
    ]);
    expect(policyFor('GET', '/admin/referrals/settlements')).toEqual([
      'referral:read',
    ]);
    // Stock writes (spec 2026-10-28).
    expect(policyFor('POST', '/admin/goods-receive-notes')).toEqual([
      'goods_receive_note:update',
    ]);
    expect(policyFor('POST', '/admin/goods-receive-notes/*/reverse')).toEqual([
      'goods_receive_note:update',
    ]);
  });

  it('the mailing list needs the Orders read policy on top of procurement', () => {
    const policyFor = (method: string, url: string) =>
      entries
        .filter((e) => e.methods.includes(method) && e.re.test(url))
        .flatMap((e) => e.policies.map((p) => `${p.resource}:${p.operation}`));
    // It returns customer names, addresses and emails.
    expect(policyFor('GET', '/admin/procurement/to-ship').sort()).toEqual([
      'delivery_order:read',
      'procurement:read',
    ]);
    expect(policyFor('GET', '/admin/procurement/to-buy')).toEqual([
      'procurement:read',
    ]);
  });

  it('secret-bearing GETs ask for their own declared read policy', () => {
    // Partner passwords and full bank numbers must not ride on a screen's read
    // policy: the view-only Support viewer holds those but not these.
    const declared = new Set(
      secretReadPolicies.policies.map((p) => `${p.resource}:${p.operation}`),
    );
    for (const s of SECRET_READS) {
      const route = routes.find(
        (r) => r.method === 'GET' && matcherToRegExp(s.matcher).test(r.url),
      );
      expect(route).toBeDefined();
      const asks = entries
        .filter((e) => e.methods.includes('GET') && e.re.test(route!.url))
        .flatMap((e) => e.policies.map((p) => `${p.resource}:${p.operation}`));
      expect(asks).toContain(`${s.resource}:read`);
      expect(declared.has(`${s.resource}:read`)).toBe(true);
    }
  });
});
