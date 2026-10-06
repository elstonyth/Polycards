import { timingSafeEqual } from 'node:crypto';
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

// The desk-reports lock (spec 2026-09-29-desk-reports-design.md). Each staff
// desk bot holds its OWN key (REPORT_KEY_<DESK>) and sends it in
// `x-report-key`. Since 2026-10-03 every desk reads every desk's reports
// (the owner's call: full read-only access for all desk bots), so any
// configured key opens any /reports/<desk>/* route. Keys stay per desk so the
// log names who read what and one bot can be cut off by rotating its key.
// Fail CLOSED: with no key configured at all every request answers 503, so a
// deploy that forgot the secrets never serves a report. Too-short keys count
// as unset. The comparison is constant-time and every refusal is the same
// bare 401.
export const REPORT_DESKS = ['finance', 'store', 'support', 'growth'] as const;
// The report areas a path may name: every desk's, plus `admin`, the desk
// bots' read-only admin proxy (reports/admin/proxy.ts), which any key opens.
const REPORT_AREAS = [...REPORT_DESKS, 'admin'] as const;
export type ReportDesk = (typeof REPORT_AREAS)[number];
// The desks holding a key: every report desk, plus Developer, which has no
// reports of its own.
const KEY_OWNERS = [...REPORT_DESKS, 'developer'] as const;
export type ReportCaller = (typeof KEY_OWNERS)[number];
const MIN_KEY_LENGTH = 32;

// Whose key opened this request: the log line names it, and the Growth
// desk's daily Excel is kept for that desk's 12 a.m. job.
const callers = new WeakMap<object, ReportCaller>();
export const reportCallerOf = (req: MedusaRequest): ReportCaller | null =>
  callers.get(req) ?? null;

// The desk is the first path segment after /reports/, lowercased: Medusa
// matches routes case-insensitively, so /reports/Finance/economy reaches the
// finance handler and must be held to the finance key. The path is read RAW,
// exactly as Express routes it. new URL() would normalize `\` and `..` and let
// the guard judge a different desk than the handler Express picks (a store
// key on /reports/finance/player/..\..\store\a), and it throws on a bad
// absolute-form target. Anything that is not an origin-form /reports/<desk>
// path is null, so it gets the bare 401.
export function deskOf(originalUrl: string): ReportDesk | null {
  const pathname = originalUrl.split(/[?#]/, 1)[0];
  const segment = /^\/reports\/([^/]+)/i.exec(pathname)?.[1]?.toLowerCase();
  return REPORT_AREAS.find((desk) => desk === segment) ?? null;
}

export function requireReportKey() {
  return (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction,
  ): void => {
    // First, so the 401 and 503 carry it too. RFC 9111 §3.5 keeps shared caches
    // from storing responses to Authorization requests only; this key is a
    // custom header, so nothing else stops a proxy caching a finance report.
    res.setHeader('Cache-Control', 'no-store');
    const desk = deskOf(req.originalUrl);
    if (!desk) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    const keys = KEY_OWNERS.flatMap((owner) => {
      const key = process.env[`REPORT_KEY_${owner.toUpperCase()}`]?.trim();
      return key && key.length >= MIN_KEY_LENGTH ? [{ owner, key }] : [];
    });
    if (!keys.length) {
      res.status(503).json({ message: 'Reports are not configured.' });
      return;
    }
    const raw = req.headers['x-report-key'];
    const given = Array.isArray(raw) ? raw[0] : raw;
    // Every configured key is compared, so the time taken does not say which
    // one matched.
    const caller =
      typeof given === 'string'
        ? keys.reduce<ReportCaller | null>(
            (found, k) => (sameKey(given, k.key) ? k.owner : found),
            null,
          )
        : null;
    if (!caller) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    callers.set(req, caller);
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(`[reports] ${caller} ${req.originalUrl}`);
    next();
  };
}

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
