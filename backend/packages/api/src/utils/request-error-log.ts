import {
  errorHandler,
  type MedusaErrorHandlerFunction,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

// Medusa's error handler logs a 5xx's error with no request id, and the id
// is only on the access line, so a failure in the logs couldn't be tied to
// the request that hit it (audit 2026-11-11). This runs the stock handler
// unchanged (same responses, same CONFLICT message swap), then logs one line
// carrying the id for any answer of 500 or more.

// The id is the caller's x-request-id when sent (loaders/index.js), and
// admin.polycards.gg is reached directly, so keep it short and printable.
export const loggableRequestId = (value: unknown): string => {
  if (typeof value !== 'string') return '-';
  return value.replace(/[^\w.:-]/g, '').slice(0, 64) || '-';
};

const stock = errorHandler();

export const requestErrorLog: MedusaErrorHandlerFunction = (
  err,
  req,
  res,
  next,
) => {
  stock(err, req, res, next);
  if (res.statusCode < 500) return;
  const logger =
    req.scope?.resolve(ContainerRegistrationKeys.LOGGER) ?? console;
  const id = loggableRequestId((req as { requestId?: unknown }).requestId);
  const message = err instanceof Error ? err.message : String(err);
  logger.error(
    `request_id=${id} ${req.method} ${req.path} -> ${res.statusCode}: ${message}`,
  );
};
