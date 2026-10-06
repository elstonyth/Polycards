import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { runReadOnlyQuery, sqlErrorMessage, sqlRefusal } from '../db-query';
import { capBody, redact } from '../proxy';

const TIMEOUT_MS = 20_000;

// GET /reports/admin/sql?sql=<one SELECT>: one read-only query on the live
// database for the desk bots (db-query.ts has the rules). The answer goes
// through the same redaction and size cap as the admin proxy: any password,
// secret, token, credential or API key field comes back [hidden].
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const sql = req.query.sql;
  const refused = sqlRefusal(sql);
  if (refused) {
    res.status(400).json({ message: refused });
    return;
  }
  // Tests shorten it; production never sets it.
  const override = Number(process.env.DESK_SQL_TIMEOUT_MS);
  try {
    const answer = await runReadOnlyQuery(
      req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
      sql as string,
      override > 0 ? override : TIMEOUT_MS,
    );
    // Through JSON first: dates become ISO strings before redact walks it.
    res.json(
      capBody(
        redact(JSON.parse(JSON.stringify(answer))),
        undefined,
        'Ask again narrower: aggregate in SQL (COUNT, SUM, GROUP BY), select fewer columns, or add LIMIT.',
      ),
    );
  } catch (err) {
    const message = sqlErrorMessage(err);
    if (message) {
      res.status(400).json({ message });
      return;
    }
    req.scope
      .resolve('logger')
      .warn(`[reports] desk-bot SQL failed: ${(err as Error)?.message}`);
    res
      .status(503)
      .json({ message: 'The database did not answer. Try again in a minute.' });
  }
}
