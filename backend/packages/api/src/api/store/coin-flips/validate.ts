import { MedusaError } from '@medusajs/framework/utils';
import { coinFlipSelection, coinFlipTicketSelection } from '../../../modules/packs/coin-flip';

export function coinFlipQuoteBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Select cards and choose Head or Tail.');
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['pull_id', 'pull_ids', 'tickets', 'chosen_side'].includes(key)) ||
      ('pull_id' in input && ('pull_ids' in input || 'tickets' in input)) ||
      !('pull_id' in input || 'pull_ids' in input || 'tickets' in input)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Unexpected coin flip parameters.');
  }
  // Existing single-card clients used the emblem (Head) implicitly.
  if ('pull_id' in input) return coinFlipSelection([input.pull_id], input.chosen_side ?? 'head');
  if (!('pull_ids' in input)) return coinFlipTicketSelection(input.tickets, input.chosen_side);
  const cards = coinFlipSelection(input.pull_ids, input.chosen_side);
  return 'tickets' in input
    ? { ...cards, tickets: coinFlipTicketSelection(input.tickets, input.chosen_side).tickets }
    : cards;
}

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
