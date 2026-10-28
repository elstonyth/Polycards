import { MedusaError } from '@medusajs/framework/utils';

export function coinFlipBody(body: unknown, key?: 'pull_id'): string {
  if (body == null && !key) return '';
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== key)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Unexpected coin flip parameters.');
  }
  if (!key) return '';
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || value !== value.trim()) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Select one card from your Vault.');
  }
  return value;
}
