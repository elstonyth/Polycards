import { timingSafeEqual } from 'node:crypto';
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

// The desk-reports lock (spec 2026-09-29-desk-reports-design.md). Each staff
// desk bot holds its OWN key (REPORT_KEY_<DESK>) and sends it in
// `x-report-key`; a key opens only its desk's routes, so the store key can
// never read /reports/finance/*. Fail CLOSED: an unset or too-short key
// answers 503, so a deploy that forgot the secret never serves a report. The
// comparison is constant-time and every refusal is the same bare 401.
export const REPORT_DESKS = ['finance', 'store', 'support', 'growth'] as const;
export type ReportDesk = (typeof REPORT_DESKS)[number];
const MIN_KEY_LENGTH = 32;

// The desk is the first path segment after /reports/, lowercased: Medusa
// matches routes case-insensitively, so /reports/Finance/economy reaches the
// finance handler and must be held to the finance key.
export function deskOf(originalUrl: string): ReportDesk | null {
  const { pathname } = new URL(originalUrl, 'http://reports.local');
  const segment = /^\/reports\/([^/]+)/i.exec(pathname)?.[1]?.toLowerCase();
  return REPORT_DESKS.find((desk) => desk === segment) ?? null;
}

export function requireReportKey() {
  return (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction,
  ): void => {
    const desk = deskOf(req.originalUrl);
    if (!desk) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    const expected =
      process.env[`REPORT_KEY_${desk.toUpperCase()}`]?.trim() ?? '';
    if (expected.length < MIN_KEY_LENGTH) {
      res
        .status(503)
        .json({ message: 'Reports are not configured for this desk.' });
      return;
    }
    const raw = req.headers['x-report-key'];
    const given = Array.isArray(raw) ? raw[0] : raw;
    if (typeof given !== 'string' || !sameKey(given, expected)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(`[reports] ${desk} ${req.originalUrl}`);
    next();
  };
}

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
