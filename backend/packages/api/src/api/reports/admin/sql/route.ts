import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { positiveIntFromEnv } from '../../../utils/rate-limit';
import { reportCallerOf } from '../../require-report-key';
import {
  runReadOnlyQuery,
  SqlBusy,
  SqlCallerGone,
  sqlErrorMessage,
  sqlForLog,
  sqlRefusal,
  SqlRefused,
} from '../db-query';

const TIMEOUT_MS = 20_000;

// POST /reports/admin/sql {"sql": "<one SELECT>"}: one read-only query on the
// live database for the admin assistant's db_query, which only super admins
// get (db-query.ts has the rules). A POST so the query never lands in a URL,
// where request logs and proxies would keep it whole and Node caps its size;
// the log line below masks every value in it.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // The desk bots' keys no longer open it (owner, 2026-11-10; security audit
  // 2026-11-09 #9: one query could use up the database's memory). Checked
  // here, on the route itself, so no spelling of the path gets past it.
  if (reportCallerOf(req) !== 'assistant') {
    res.status(403).json({
      message: 'Database queries are only available in the admin assistant.',
    });
    return;
  }
  const sql = (req.body as { sql?: unknown } | undefined)?.sql;
  const refused = sqlRefusal(sql);
  if (refused) {
    res.status(400).json({ message: refused });
    return;
  }
  const logger = req.scope.resolve('logger');
  logger.info(
    `[reports] ${reportCallerOf(req) ?? '?'} sql: ${sqlForLog(sql as string)}`,
  );
  try {
    res.json(
      await runReadOnlyQuery(
        req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
        sql as string,
        // Tests shorten it; production never sets it.
        positiveIntFromEnv('DESK_SQL_TIMEOUT_MS', TIMEOUT_MS),
        () => req.socket?.destroyed === true,
      ),
    );
  } catch (err) {
    if (err instanceof SqlCallerGone) return;
    if (err instanceof SqlBusy) {
      res.status(429).json({ message: err.message });
      return;
    }
    const message =
      err instanceof SqlRefused ? err.message : sqlErrorMessage(err);
    if (message) {
      res.status(400).json({ message });
      return;
    }
    logger.warn(`[reports] desk-bot SQL failed: ${(err as Error)?.message}`);
    // 504, like the admin proxy's: 503 means "no report keys set up".
    res
      .status(504)
      .json({ message: 'The database did not answer. Try again in a minute.' });
  }
}
