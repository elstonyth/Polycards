import { MedusaError } from '@medusajs/framework/utils';

export const MAX_MONITORED_ACCOUNTS = 80;

export function monitoredEmails(body: unknown): string[] {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== 'emails')
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Provide an emails array only.',
    );
  }
  const emails = (body as Record<string, unknown>).emails;
  if (
    !Array.isArray(emails) ||
    emails.length < 1 ||
    emails.length > MAX_MONITORED_ACCOUNTS ||
    !emails.every(
      (email): email is string =>
        typeof email === 'string' &&
        email.trim().length <= 254 &&
        /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email.trim()),
    )
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Provide 1–80 valid account email addresses.',
    );
  }
  const normalized = emails.map((email) => email.trim().toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Duplicate account email addresses.',
    );
  }
  return normalized;
}

export function monitoredCustomerIds(
  accounts: Record<string, unknown> | undefined,
): string[] {
  if (accounts === undefined) return [];
  const ids = accounts.customer_ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_MONITORED_ACCOUNTS ||
    !ids.every((id): id is string => typeof id === 'string' && id.length > 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Saved account selection is invalid.',
    );
  }
  return ids;
}
